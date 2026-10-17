"""Inference for a ScamShield checkpoint, shared by evaluation and the serving API.

The verdict is not sampled. We score the log-likelihood of each verdict line
("scam" / "suspicious" / "safe") and softmax over the three. That gives a calibrated
probability, so the API can apply a threshold tuned for a target false-positive rate
instead of trusting whatever the model happens to generate. The reason is then generated
conditioned on the chosen verdict, so the explanation always agrees with the decision.
"""

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

from common import STUDENT_SYSTEM_PROMPT, VERDICTS


class Scorer:
    def __init__(self, model_path: str, device: str | None = None, dtype=torch.bfloat16):
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.tok = AutoTokenizer.from_pretrained(model_path)
        if self.tok.pad_token is None:
            self.tok.pad_token = self.tok.eos_token
        self.model = AutoModelForCausalLM.from_pretrained(model_path, dtype=dtype).to(self.device).eval()

    def chat_prefix(self, prompt: str) -> str:
        messages = [{"role": "system", "content": STUDENT_SYSTEM_PROMPT}, {"role": "user", "content": prompt}]
        return self.tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)

    @torch.no_grad()
    def verdict_probs(self, prompts: list[str]) -> list[dict[str, float]]:
        """P(verdict | message) for each prompt, normalized over the three verdicts.

        The message is encoded once and its KV cache is shared by the three verdict
        continuations, so a check costs about one forward pass over the message instead
        of three. Only the logits actually scored are computed (a full 150k-vocab logit
        tensor per position would need GBs for long emails).
        """
        n_v, pad = len(VERDICTS), self.tok.pad_token_id
        cands = [self.tok(v + "\n", add_special_tokens=False)["input_ids"] for v in VERDICTS]
        prefixes = [self.tok(self.chat_prefix(p), add_special_tokens=False)["input_ids"] for p in prompts]

        # 1) Encode each message once (left-padded so every row ends at the last position).
        P = max(map(len, prefixes))
        ids = torch.tensor([[pad] * (P - len(x)) + x for x in prefixes], device=self.device)
        attn = torch.tensor([[0] * (P - len(x)) + [1] * len(x) for x in prefixes], device=self.device)
        out = self.model(input_ids=ids, attention_mask=attn, position_ids=(attn.cumsum(-1) - 1).clamp(min=0),
                         use_cache=True, logits_to_keep=1)
        first = torch.log_softmax(out.logits[:, -1].float(), dim=-1)  # predicts each candidate's first token
        scores = torch.stack([first[:, c[0]] for c in cands], dim=1)  # [B, n_v]

        # 2) Score the rest of each verdict line against the shared cache.
        rest = max(len(c) for c in cands) - 1
        if rest > 0:
            B = len(prompts)
            cache = out.past_key_values
            cache.batch_repeat_interleave(n_v)  # rows: p0v0, p0v1, p0v2, p1v0, ...
            # Feed tokens 0..L-2 of each candidate to predict tokens 1..L-1 (right-padded).
            inp = torch.tensor([c[:-1] + [pad] * (rest - len(c) + 1) for c in cands], device=self.device).repeat(B, 1)
            cmask = torch.tensor([[1] * (len(c) - 1) + [0] * (rest - len(c) + 1) for c in cands], device=self.device).repeat(B, 1)
            prefix_len = attn.sum(-1).repeat_interleave(n_v)
            logits = self.model(
                input_ids=inp,
                attention_mask=torch.cat([attn.repeat_interleave(n_v, dim=0), cmask], dim=1),
                position_ids=prefix_len[:, None] + torch.arange(rest, device=self.device)[None],
                past_key_values=cache,
            ).logits
            lp = torch.log_softmax(logits.float(), dim=-1)  # [B * n_v, rest, vocab]
            for j, c in enumerate(cands):
                if len(c) > 1:
                    rows = torch.arange(j, B * n_v, n_v, device=self.device)
                    tgt = torch.tensor(c[1:], device=self.device)[None, :, None].expand(B, -1, 1)
                    scores[:, j] += lp[rows, : len(c) - 1].gather(-1, tgt).squeeze(-1).sum(-1)

        return [dict(zip(VERDICTS, row.tolist())) for row in torch.softmax(scores, dim=1)]

    @torch.no_grad()
    def reason(self, prompt: str, verdict: str, max_new_tokens: int = 60) -> str:
        text = self.chat_prefix(prompt) + verdict + "\nReason:"
        enc = self.tok(text, add_special_tokens=False, return_tensors="pt").to(self.device)
        out = self.model.generate(
            input_ids=enc["input_ids"], attention_mask=enc["attention_mask"],
            max_new_tokens=max_new_tokens, do_sample=False, pad_token_id=self.tok.pad_token_id,
        )
        return self.tok.decode(out[0, enc["input_ids"].shape[1] :], skip_special_tokens=True).split("\n")[0].strip()


def decide(probs: dict[str, float], scam_threshold: float, suspicious_threshold: float) -> str:
    """Map probabilities to a verdict using thresholds tuned on the validation set."""
    if probs["scam"] >= scam_threshold:
        return "scam"
    if probs["scam"] + probs["suspicious"] >= suspicious_threshold:
        return "suspicious"
    return "safe"
