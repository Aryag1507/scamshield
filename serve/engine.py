"""Inference engine: one thread owns the model and schedules all work on it.

Verdicts: every verdict request waiting when the scheduler wakes is scored in one batched
forward pass (Scorer.verdict_probs already shares each message's KV cache across verdicts).

Explanations: continuous batching. Each running sequence keeps its own KV cache. Every
scheduler iteration first prefills newly arrived sequences, then advances *all* running
sequences by one token in a single batched forward pass: caches are left-padded to a common
length, decoded together, and split back. A request that arrives mid-generation joins the
next step instead of waiting for the batch to drain. On CPU a decode step is dominated by
reading the weights, so N sequences per step cost little more than one.

Tokens are emitted through a callback as they're produced, which the API turns into a stream.
"""

import queue
import threading
from concurrent.futures import Future
from dataclasses import dataclass, field
from typing import Callable

import torch
from transformers import DynamicCache

from scorer import Scorer


@dataclass
class _VerdictJob:
    prompt: str
    future: Future


@dataclass
class _GenJob:
    text: str  # full model input, e.g. chat prefix + "scam\nReason:"
    max_new: int
    on_token: Callable[[str], None] | None
    future: Future
    # running state
    kv: list[tuple[torch.Tensor, torch.Tensor]] = field(default_factory=list)  # per layer, [1, heads, len, dim]
    length: int = 0
    next_token: int = -1
    out_ids: list[int] = field(default_factory=list)
    emitted: str = ""


class Engine:
    def __init__(self, scorer: Scorer, max_batch: int = 8):
        self.scorer, self.model, self.tok = scorer, scorer.model, scorer.tok
        self.max_batch = max_batch
        self.inbox: queue.Queue = queue.Queue()
        self.stop_ids = {self.tok.eos_token_id, *self.tok("\n", add_special_tokens=False)["input_ids"]}
        self.stats = {"verdict_batches": 0, "verdict_jobs": 0, "decode_steps": 0, "decoded_tokens": 0, "max_running": 0}
        threading.Thread(target=self._loop, name="engine", daemon=True).start()

    # --- public API (thread-safe) -------------------------------------------------------

    def verdict(self, prompt: str) -> Future:
        fut: Future = Future()
        self.inbox.put(_VerdictJob(prompt, fut))
        return fut

    def generate(self, text: str, max_new: int = 60, on_token: Callable[[str], None] | None = None) -> Future:
        fut: Future = Future()
        self.inbox.put(_GenJob(text, max_new, on_token, fut))
        return fut

    # --- scheduler ----------------------------------------------------------------------

    def _loop(self) -> None:
        running: list[_GenJob] = []
        waiting: list[_GenJob] = []
        while True:
            # Block only when there is nothing in flight; otherwise just drain what's arrived.
            jobs = [self.inbox.get()] if not running and not waiting else []
            while True:
                try:
                    jobs.append(self.inbox.get_nowait())
                except queue.Empty:
                    break
            verdicts = [j for j in jobs if isinstance(j, _VerdictJob)]
            waiting += [j for j in jobs if isinstance(j, _GenJob)]

            try:
                if verdicts:  # short, latency-sensitive: always first
                    self._run_verdicts(verdicts)
                while waiting and len(running) < self.max_batch:
                    job = waiting.pop(0)
                    if self._prefill(job):
                        running.append(job)
                if running:
                    self._decode_step(running)
                    running = [j for j in running if not j.future.done()]
            except Exception as e:  # never let one bad batch kill the engine thread
                for j in verdicts + running:
                    if not j.future.done():
                        j.future.set_exception(e)
                running = []

    @torch.no_grad()
    def _run_verdicts(self, jobs: list[_VerdictJob]) -> None:
        probs = self.scorer.verdict_probs([j.prompt for j in jobs])
        for j, p in zip(jobs, probs):
            j.future.set_result(p)
        self.stats["verdict_batches"] += 1
        self.stats["verdict_jobs"] += len(jobs)

    @torch.no_grad()
    def _prefill(self, job: _GenJob) -> bool:
        ids = torch.tensor([self.tok(job.text, add_special_tokens=False)["input_ids"]], device=self.model.device)
        out = self.model(input_ids=ids, use_cache=True, logits_to_keep=1)
        job.kv = [(layer.keys, layer.values) for layer in out.past_key_values.layers]
        job.length = ids.shape[1]
        return self._accept(job, int(out.logits[0, -1].argmax()))

    @torch.no_grad()
    def _decode_step(self, jobs: list[_GenJob]) -> None:
        """Advance every running sequence by one token in one batched forward pass."""
        L = max(j.length for j in jobs)
        n_layers = len(jobs[0].kv)
        batched = []
        for layer in range(n_layers):
            ks, vs = [], []
            for j in jobs:
                k, v = j.kv[layer]
                pad = L - j.length
                ks.append(torch.nn.functional.pad(k, (0, 0, pad, 0)))  # left-pad along the sequence dim
                vs.append(torch.nn.functional.pad(v, (0, 0, pad, 0)))
            batched.append((torch.cat(ks), torch.cat(vs)))
        cache = DynamicCache.from_legacy_cache(tuple(batched))

        dev = self.model.device
        attn = torch.zeros(len(jobs), L + 1, dtype=torch.long, device=dev)
        for i, j in enumerate(jobs):
            attn[i, L - j.length :] = 1
        input_ids = torch.tensor([[j.next_token] for j in jobs], device=dev)
        position_ids = torch.tensor([[j.length] for j in jobs], device=dev)
        out = self.model(input_ids=input_ids, attention_mask=attn, position_ids=position_ids,
                         past_key_values=cache, use_cache=True)

        next_tokens = out.logits[:, -1].argmax(-1).tolist()
        new_layers = out.past_key_values.layers
        for i, j in enumerate(jobs):
            start = L - j.length  # drop this row's left padding
            # clone: a view would keep the whole batched tensor alive
            j.kv = [(layer.keys[i : i + 1, :, start:].clone(), layer.values[i : i + 1, :, start:].clone()) for layer in new_layers]
            j.length += 1
            self._accept(j, next_tokens[i])
        self.stats["decode_steps"] += 1
        self.stats["decoded_tokens"] += len(jobs)
        self.stats["max_running"] = max(self.stats["max_running"], len(jobs))

    def _accept(self, job: _GenJob, token: int) -> bool:
        """Record a newly predicted token; finish the job on a stop token or length limit.
        Returns True while the job still needs decoding."""
        if token in self.stop_ids or len(job.out_ids) >= job.max_new:
            self._finish(job)
            return False
        job.out_ids.append(token)
        job.next_token = token
        text = self.tok.decode(job.out_ids, skip_special_tokens=True)
        if "\n" in text:  # a token like ".\n" ends the one-line reason too
            self._finish(job)
            return False
        # Emit only complete characters (a multi-byte character can span tokens).
        if job.on_token and not text.endswith("�") and len(text) > len(job.emitted):
            job.on_token(text[len(job.emitted) :])
            job.emitted = text
        return True

    def _finish(self, job: _GenJob) -> None:
        text = self.tok.decode(job.out_ids, skip_special_tokens=True).split("\n")[0]
        if job.on_token and len(text) > len(job.emitted):
            job.on_token(text[len(job.emitted) :])
        job.kv = []
        job.future.set_result(text.strip())
