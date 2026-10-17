"""Merge teacher-labeled public data + synthetic data and split into train / val / test.

Splits are by `group` (one synthetic batch request, or one public row) so near-duplicate
messages generated in the same request never straddle train and test.

A few whole scam categories are held out into `test_unseen.jsonl`: recall there measures
whether the model generalizes to scam *types* it never trained on, which is what matters
when a new scam wave appears.
"""

import argparse
import random
from collections import Counter, defaultdict

from common import DATA_DIR, VERDICTS, format_input, format_target, read_jsonl, write_jsonl

HELD_OUT_CATEGORIES = ("jury_duty_fine", "rental_housing", "crypto_drainer")


def to_example(r: dict) -> dict:
    return {
        "id": r["id"],
        "prompt": format_input(r["text"], r["channel"], r.get("sender"), r.get("subject")),
        "target": format_target(r["verdict"], r["reason"]),
        "verdict": r["verdict"],
        "channel": r["channel"],
        "source": r["source"],
        "category": r.get("category"),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--val-frac", type=float, default=0.075)
    parser.add_argument("--test-frac", type=float, default=0.075)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    rows = []
    for name in ("public_labeled.jsonl", "synthetic.jsonl"):
        path = DATA_DIR / name
        if path.exists():
            rows += read_jsonl(path)
        else:
            print(f"warning: {path} missing, skipping")
    if not rows:
        raise SystemExit("no data; run build_public.py and teacher.py first")

    unseen = [r for r in rows if r.get("category") in HELD_OUT_CATEGORIES]
    rows = [r for r in rows if r.get("category") not in HELD_OUT_CATEGORIES]

    groups = defaultdict(list)
    for r in rows:
        groups[r["group"]].append(r)
    keys = sorted(groups)
    random.Random(args.seed).shuffle(keys)
    n_val, n_test = int(len(keys) * args.val_frac), int(len(keys) * args.test_frac)
    split_keys = {"val": keys[:n_val], "test": keys[n_val : n_val + n_test], "train": keys[n_val + n_test :]}

    for split, ks in split_keys.items():
        examples = [to_example(r) for k in ks for r in groups[k]]
        write_jsonl(DATA_DIR / f"{split}.jsonl", examples)
        print(f"{split:12s} {len(examples):6d}  {dict(Counter(e['verdict'] for e in examples))}")
    write_jsonl(DATA_DIR / "test_unseen.jsonl", [to_example(r) for r in unseen])
    print(f"{'test_unseen':12s} {len(unseen):6d}  held-out categories: {', '.join(HELD_OUT_CATEGORIES)}")
    assert all(r["verdict"] in VERDICTS for r in rows + unseen)


if __name__ == "__main__":
    main()
