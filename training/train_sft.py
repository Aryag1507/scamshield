"""Full-parameter supervised fine-tuning of a small instruct model on ScamShield data.

Loss is computed only on the assistant turn (verdict + reason); the system prompt and
message are masked out. Runs on any CUDA GPU; modal_app.py runs it on a cloud GPU.

Memory note: the default causal-LM loss materializes logits over the full ~150k vocab for
every token in the batch (~7GB for 8 long emails). Only the ~30 answer tokens per example
are trained on, so AnswerOnlyLossTrainer applies the LM head to just those positions.
"""

import argparse
import math
import os
import random
from collections import Counter

import torch
import torch.nn.functional as F
from torch.utils.data import Dataset
from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainingArguments

from common import STUDENT_SYSTEM_PROMPT, VERDICTS, read_jsonl

IGNORE = -100


class SFTDataset(Dataset):
    def __init__(self, rows: list[dict], tok, max_len: int):
        self.items = [self.encode(r, tok, max_len) for r in rows]

    @staticmethod
    def encode(row: dict, tok, max_len: int) -> dict:
        messages = [{"role": "system", "content": STUDENT_SYSTEM_PROMPT}, {"role": "user", "content": row["prompt"]}]
        prefix = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        full = tok.apply_chat_template(messages + [{"role": "assistant", "content": row["target"]}], tokenize=False)
        assert full.startswith(prefix), "chat template must render the prompt as a prefix of the full conversation"

        prefix_ids = tok(prefix, add_special_tokens=False)["input_ids"]
        target_ids = tok(full[len(prefix) :], add_special_tokens=False)["input_ids"]
        # Truncate the message, never the answer.
        prefix_ids = prefix_ids[: max_len - len(target_ids)]
        return {"input_ids": prefix_ids + target_ids, "labels": [IGNORE] * len(prefix_ids) + target_ids}

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        return self.items[i]


class AnswerOnlyLossTrainer(Trainer):
    """Same loss as the standard causal-LM loss, without full-vocab logits for masked positions."""

    def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
        labels = inputs.pop("labels")
        base = model.module if hasattr(model, "module") else model
        hidden = base.model(input_ids=inputs["input_ids"], attention_mask=inputs["attention_mask"]).last_hidden_state
        # Position t predicts token t+1.
        targets = labels[:, 1:]
        mask = targets != IGNORE
        logits = base.lm_head(hidden[:, :-1][mask])
        loss = F.cross_entropy(logits.float(), targets[mask], reduction="sum")
        # With gradient accumulation the Trainer passes the label-token count across all
        # accumulated micro-batches, so the summed loss is normalized over the full step.
        loss = loss / (num_items_in_batch if num_items_in_batch is not None else mask.sum().clamp(min=1))
        return (loss, {"loss": loss}) if return_outputs else loss


def make_collator(pad_id: int):
    def collate(batch):
        n = max(len(b["input_ids"]) for b in batch)
        return {
            "input_ids": torch.tensor([b["input_ids"] + [pad_id] * (n - len(b["input_ids"])) for b in batch]),
            "labels": torch.tensor([b["labels"] + [IGNORE] * (n - len(b["labels"])) for b in batch]),
            "attention_mask": torch.tensor([[1] * len(b["input_ids"]) + [0] * (n - len(b["input_ids"])) for b in batch]),
        }

    return collate


def rebalance(rows: list[dict], min_frac: float, seed: int) -> list[dict]:
    """Oversample rare verdicts (usually 'suspicious') up to min_frac of the training set."""
    rng = random.Random(seed)
    by_verdict = {v: [r for r in rows if r["verdict"] == v] for v in VERDICTS}
    out = list(rows)
    for v, group in by_verdict.items():
        need = int(min_frac * len(rows)) - len(group)
        if group and need > 0:
            out += rng.choices(group, k=need)
    rng.shuffle(out)
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-model", default="Qwen/Qwen2.5-0.5B-Instruct")
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--epochs", type=float, default=2)
    parser.add_argument("--lr", type=float, default=2e-5)
    parser.add_argument("--batch-size", type=int, default=8)  # x grad-accum 4 = effective 32; fits a 24GB L4
    parser.add_argument("--grad-accum", type=int, default=4)
    parser.add_argument("--max-len", type=int, default=1536)
    parser.add_argument("--min-class-frac", type=float, default=0.12)
    parser.add_argument("--max-train", type=int, default=None, help="cap training rows (for smoke tests)")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    tok = AutoTokenizer.from_pretrained(args.base_model)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    train_rows = read_jsonl(f"{args.data_dir}/train.jsonl")[: args.max_train]
    val_rows = read_jsonl(f"{args.data_dir}/val.jsonl")
    if args.max_train:
        val_rows = val_rows[: max(8, args.max_train // 10)]
    train_rows = rebalance(train_rows, args.min_class_frac, args.seed)
    print(f"train {len(train_rows)} {dict(Counter(r['verdict'] for r in train_rows))}, val {len(val_rows)}")

    train_ds, val_ds = SFTDataset(train_rows, tok, args.max_len), SFTDataset(val_rows, tok, args.max_len)

    use_cuda = torch.cuda.is_available()
    # fp32 master weights + bf16 autocast (bf16=True below). Pure-bf16 weights would round
    # away full-fine-tune updates at this learning rate.
    model = AutoModelForCausalLM.from_pretrained(args.base_model, dtype=torch.float32)

    steps_per_epoch = math.ceil(len(train_ds) / (args.batch_size * args.grad_accum))
    total_steps = int(steps_per_epoch * args.epochs)
    eval_every = max(1, min(200, total_steps // 8))

    training_args = TrainingArguments(
        output_dir=args.output_dir,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_steps=max(1, int(0.03 * total_steps)),
        weight_decay=0.0,
        bf16=use_cuda,
        gradient_checkpointing=use_cuda,
        logging_steps=max(1, eval_every // 10),
        eval_strategy="steps",
        eval_steps=eval_every,
        save_strategy="steps",
        save_steps=eval_every,
        save_total_limit=2,
        load_best_model_at_end=True,
        metric_for_best_model="eval_loss",
        report_to="wandb" if os.environ.get("WANDB_API_KEY") else "none",
        run_name=os.path.basename(args.output_dir.rstrip("/")),
        seed=args.seed,
        dataloader_num_workers=2 if use_cuda else 0,
        prediction_loss_only=True,
        group_by_length=True,  # batch similar-length examples: short SMS stop padding to long emails
    )
    trainer = AnswerOnlyLossTrainer(
        model=model,
        args=training_args,
        train_dataset=train_ds,
        eval_dataset=val_ds,
        data_collator=make_collator(tok.pad_token_id),
    )
    trainer.train()

    final = f"{args.output_dir}/final"
    trainer.save_model(final)
    tok.save_pretrained(final)
    # Marker for modal_app's watchdog: the model is fully written, so a hang after this point
    # (e.g. W&B's uploader stuck at shutdown) is safe to kill.
    open(f"{final}/TRAINING_COMPLETE", "w").close()
    print(f"saved {final}")


if __name__ == "__main__":
    main()
