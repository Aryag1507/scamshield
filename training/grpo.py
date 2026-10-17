"""GRPO (Group Relative Policy Optimization) post-training, implemented from scratch.

Starting from the SFT model, each step:
  1. Samples B training messages and generates G completions ("verdict\\nReason: ...") for each.
  2. Scores every completion:
       verdict reward   +1 correct, +0.25 scam<->suspicious, -1 wrong, -1.5 a false alarm
                        (calling a safe message a scam), -1 unparseable
       reason reward    teacher-judge quality in [0, 1] (specific, accurate, concise),
                        weighted by --reason-weight; only for parseable completions
  3. Advantage = (reward - group mean) / group std: each completion is compared only with
     its siblings for the same message, so no value network is needed.
  4. Policy-gradient loss on completion tokens + a KL penalty (k3 estimator) toward the
     frozen SFT model, so the policy improves without drifting into degenerate text.

One gradient update per batch of samples, so the PPO importance ratio is 1 and the clipped
objective reduces to the plain policy gradient (written with the exp(logp - logp.detach())
form so the gradient is identical). Like train_sft.py, the LM head is applied only to the
positions being scored, which keeps 150k-vocab logits out of memory.
"""

import argparse
import asyncio
import json
import math
import os
import random
import time
from pathlib import Path

import torch
import torch.nn.functional as F
from transformers import AutoModelForCausalLM, AutoTokenizer

from common import STUDENT_SYSTEM_PROMPT, VERDICTS, parse_target, read_jsonl
from judge import Judge


def verdict_reward(pred: str | None, gold: str) -> float:
    if pred is None:
        return -1.0
    if pred == gold:
        return 1.0
    if gold == "safe" and pred == "scam":
        return -1.5  # false alarms are what get a scam detector uninstalled
    if {pred, gold} == {"scam", "suspicious"}:
        return 0.25
    return -1.0


def chat_prefix(tok, prompt: str) -> str:
    messages = [{"role": "system", "content": STUDENT_SYSTEM_PROMPT}, {"role": "user", "content": prompt}]
    return tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)


def sample_batch(rows_by_verdict: dict[str, list[dict]], n: int, rng: random.Random) -> list[dict]:
    """Balanced over verdicts so the rare classes get as much learning signal as 'safe'."""
    out = []
    for i in range(n):
        out.append(rng.choice(rows_by_verdict[VERDICTS[i % len(VERDICTS)]]))
    return out


@torch.no_grad()
def generate(model, tok, prefixes: list[str], group: int, max_new: int, temperature: float):
    """G samples per prefix. Returns (prompt_ids [N, P] left-padded, completion_ids [N, C], completion_mask [N, C])."""
    tok.padding_side = "left"
    enc = tok(prefixes, return_tensors="pt", padding=True, add_special_tokens=False).to(model.device)
    ids = enc["input_ids"].repeat_interleave(group, dim=0)
    mask = enc["attention_mask"].repeat_interleave(group, dim=0)
    model.eval()
    out = model.generate(input_ids=ids, attention_mask=mask, do_sample=True, temperature=temperature, top_p=1.0,
                         top_k=0, max_new_tokens=max_new, pad_token_id=tok.pad_token_id, eos_token_id=tok.eos_token_id)
    completion = out[:, ids.shape[1]:]
    # Mask everything after the first EOS (generate pads finished rows with pad tokens).
    is_eos = completion == tok.eos_token_id
    after_eos = (is_eos.cumsum(dim=1) - is_eos.long()) > 0
    cmask = (~after_eos & (completion != tok.pad_token_id) | is_eos & ~after_eos).long()
    return ids, mask, completion, cmask


def completion_logprobs(model, prompt_ids, prompt_mask, completion, cmask) -> torch.Tensor:
    """Per-token log-probs of the completion under `model`, [N, C]. LM head only on completion positions."""
    input_ids = torch.cat([prompt_ids, completion], dim=1)
    attn = torch.cat([prompt_mask, cmask], dim=1)
    position_ids = (attn.cumsum(-1) - 1).clamp(min=0)
    hidden = model.model(input_ids=input_ids, attention_mask=attn, position_ids=position_ids).last_hidden_state
    P, C = prompt_ids.shape[1], completion.shape[1]
    h = hidden[:, P - 1 : P - 1 + C]  # position t predicts token t+1
    logits = model.lm_head(h).float()
    return torch.gather(F.log_softmax(logits, dim=-1), -1, completion.unsqueeze(-1)).squeeze(-1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--policy", required=True, help="SFT checkpoint to start from (also the KL reference)")
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--steps", type=int, default=150)
    parser.add_argument("--batch-prompts", type=int, default=8)
    parser.add_argument("--group", type=int, default=8)
    parser.add_argument("--micro-batch", type=int, default=16, help="sequences per forward/backward")
    parser.add_argument("--lr", type=float, default=1e-6)
    parser.add_argument("--kl-coef", type=float, default=0.04)
    parser.add_argument("--reason-weight", type=float, default=0.5)
    parser.add_argument("--temperature", type=float, default=1.0)
    parser.add_argument("--max-new-tokens", type=int, default=64)
    parser.add_argument("--max-prompt-tokens", type=int, default=1024)
    parser.add_argument("--save-every", type=int, default=50)
    parser.add_argument("--no-judge", action="store_true", help="verdict reward only (smoke tests)")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    rng = random.Random(args.seed)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    use_bf16 = device == "cuda"

    tok = AutoTokenizer.from_pretrained(args.policy)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    # fp32 master weights (bf16 autocast for compute), same reasoning as SFT: tiny lr updates
    # would round away in bf16 weights.
    policy = AutoModelForCausalLM.from_pretrained(args.policy, dtype=torch.float32).to(device)
    ref = AutoModelForCausalLM.from_pretrained(args.policy, dtype=torch.bfloat16 if use_bf16 else torch.float32).to(device).eval()
    for p in ref.parameters():
        p.requires_grad_(False)
    if device == "cuda":
        policy.gradient_checkpointing_enable()
        policy.config.use_cache = False
    optim = torch.optim.AdamW(policy.parameters(), lr=args.lr, weight_decay=0.0)

    rows = read_jsonl(f"{args.data_dir}/train.jsonl")
    # Keep prompts short enough that B*G sequences fit; the SFT model already handles long ones.
    rows = [r for r in rows if len(tok(chat_prefix(tok, r["prompt"]), add_special_tokens=False)["input_ids"]) <= args.max_prompt_tokens]
    by_verdict = {v: [r for r in rows if r["verdict"] == v] for v in VERDICTS}
    print(f"GRPO on {len(rows)} prompts {({v: len(x) for v, x in by_verdict.items()})}")

    judge = None if args.no_judge else Judge()
    # One event loop for the whole run: the judge's semaphore and HTTP client bind to the loop
    # they first wait on, so a fresh asyncio.run() per step crashes on step 2.
    loop = asyncio.new_event_loop()
    wandb_run = None
    if os.environ.get("WANDB_API_KEY"):
        import wandb

        wandb_run = wandb.init(project="scamshield", name=Path(args.output_dir).name, config=vars(args))

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    log_path = out_dir / "grpo_log.jsonl"

    for step in range(1, args.steps + 1):
        t0 = time.time()
        batch = sample_batch(by_verdict, args.batch_prompts, rng)
        prefixes = [chat_prefix(tok, r["prompt"]) for r in batch]
        with torch.autocast(device_type=device, dtype=torch.bfloat16, enabled=use_bf16):
            policy.config.use_cache = True
            prompt_ids, prompt_mask, completion, cmask = generate(policy, tok, prefixes, args.group, args.max_new_tokens, args.temperature)
            policy.config.use_cache = False
        t_gen = time.time() - t0

        # --- rewards ---
        texts = tok.batch_decode(completion * cmask + tok.pad_token_id * (1 - cmask), skip_special_tokens=True)
        golds = [r["verdict"] for r in batch for _ in range(args.group)]
        messages = [r["prompt"] for r in batch for _ in range(args.group)]
        parsed = [parse_target(t) for t in texts]
        v_rewards = [verdict_reward(p, g) for (p, _), g in zip(parsed, golds)]
        quality: list[float | None] = [None] * len(texts)
        if judge:
            graded = [i for i, (p, _) in enumerate(parsed) if p is not None]  # unparseable earns no reason reward
            scores = loop.run_until_complete(judge.score_many([(messages[i], parsed[i][0], parsed[i][1]) for i in graded]))
            for i, q in zip(graded, scores):
                quality[i] = q
        r_rewards = [args.reason_weight * q if (q is not None and p is not None) else 0.0 for q, (p, _) in zip(quality, parsed)]
        rewards = torch.tensor([v + r for v, r in zip(v_rewards, r_rewards)], device=device)

        # --- group-relative advantages ---
        grouped = rewards.view(args.batch_prompts, args.group)
        std = grouped.std(dim=1, keepdim=True)
        adv = ((grouped - grouped.mean(dim=1, keepdim=True)) / (std + 1e-4)).view(-1)
        informative = (std.view(-1) > 1e-6).repeat_interleave(args.group)  # groups with no spread teach nothing

        # --- policy update ---
        policy.train()
        optim.zero_grad(set_to_none=True)
        n_tokens = cmask[informative].sum().clamp(min=1)
        stats = {"kl": 0.0, "pg": 0.0}
        idx = informative.nonzero().view(-1).tolist()
        for i in range(0, len(idx), args.micro_batch):
            mb = idx[i : i + args.micro_batch]
            with torch.autocast(device_type=device, dtype=torch.bfloat16, enabled=use_bf16):
                logp = completion_logprobs(policy, prompt_ids[mb], prompt_mask[mb], completion[mb], cmask[mb])
                with torch.no_grad():
                    ref_logp = completion_logprobs(ref, prompt_ids[mb], prompt_mask[mb], completion[mb], cmask[mb])
            m = cmask[mb].float()
            ratio = torch.exp(logp - logp.detach())  # == 1, carries the policy gradient
            pg = -(ratio * adv[mb, None]) * m
            delta = ref_logp - logp
            kl = (torch.exp(delta) - delta - 1) * m  # k3 estimator, always >= 0
            loss = (pg + args.kl_coef * kl).sum() / n_tokens  # token-level normalization over the whole step
            loss.backward()
            stats["pg"] += pg.sum().item() / n_tokens.item()
            stats["kl"] += kl.sum().item() / n_tokens.item()
        grad_norm = torch.nn.utils.clip_grad_norm_(policy.parameters(), 1.0).item() if idx else 0.0
        if idx:
            optim.step()

        q_known = [q for q in quality if q is not None]
        record = {
            "step": step,
            "reward": rewards.mean().item(),
            "verdict_acc": sum(p == g for (p, _), g in zip(parsed, golds)) / len(golds),
            "false_alarm_rate": sum(p == "scam" and g == "safe" for (p, _), g in zip(parsed, golds)) / max(1, golds.count("safe")),
            "unparseable": sum(p is None for p, _ in parsed) / len(parsed),
            "reason_quality": sum(q_known) / len(q_known) if q_known else float("nan"),
            "kl": stats["kl"],
            "grad_norm": grad_norm,
            "informative_groups": int(informative.sum().item()) // args.group,
            "completion_tokens": cmask.sum(dim=1).float().mean().item(),
            "gen_s": round(t_gen, 1),
            "step_s": round(time.time() - t0, 1),
        }
        if judge:
            record["judge_calls"], record["judge_failures"] = judge.calls, judge.failures
        print(json.dumps(record))
        with open(log_path, "a") as f:
            f.write(json.dumps(record) + "\n")
        if wandb_run:
            wandb_run.log({k: v for k, v in record.items() if isinstance(v, (int, float)) and not math.isnan(v)}, step=step)
        if step % args.save_every == 0 or step == args.steps:
            ckpt = out_dir / ("final" if step == args.steps else f"step-{step}")
            policy.save_pretrained(ckpt)
            tok.save_pretrained(ckpt)
            print(f"saved {ckpt}")

    loop.close()
    open(out_dir / "final" / "TRAINING_COMPLETE", "w").close()
    if wandb_run:
        wandb_run.finish()


if __name__ == "__main__":
    main()
