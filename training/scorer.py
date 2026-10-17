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
        """P(verdict | message) for each prompt, normalized over the three verdicts."""
        seqs, cand_lens = [], []
        for p in prompts:
            prefix_ids = self.tok(self.chat_prefix(p), add_special_tokens=False)["input_ids"]
            for v in VERDICTS:
                cand_ids = self.tok(v + "\n", add_special_tokens=False)["input_ids"]
                seqs.append(prefix_ids + cand_ids)
                cand_lens.append(len(cand_ids))

        # Left-pad so every candidate ends at the last position, then only compute vocab
        # logits for the last few positions. Full-sequence logits over a 150k vocab would
        # need tens of GB for a batch of long emails.
        max_len, pad = max(map(len, seqs)), self.tok.pad_token_id
        input_ids = torch.tensor([[pad] * (max_len - len(s)) + s for s in seqs], device=self.device)
        attn = torch.tensor([[0] * (max_len - len(s)) + [1] * len(s) for s in seqs], device=self.device)
        position_ids = (attn.cumsum(-1) - 1).clamp(min=0)
        keep = max(cand_lens) + 1
        logits = self.model(input_ids=input_ids, attention_mask=attn, position_ids=position_ids, logits_to_keep=keep).logits
        logprobs = torch.log_softmax(logits.float(), dim=-1)  # [batch, keep, vocab]

        scores = []
        for i, n in enumerate(cand_lens):
            # Logits at position t predict token t+1: the n candidate tokens are predicted by
            # kept positions keep-n-1 .. keep-2.
            targets = input_ids[i, max_len - n :]
            scores.append(logprobs[i, keep - n - 1 : keep - 1].gather(-1, targets[:, None]).sum().item())

        out = []
        for j in range(len(prompts)):
            s = torch.tensor(scores[j * len(VERDICTS) : (j + 1) * len(VERDICTS)])
            out.append(dict(zip(VERDICTS, torch.softmax(s, 0).tolist())))
        return out

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
