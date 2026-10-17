"""Explanation-quality eval: the same test messages, each model explains the gold verdict, the
teacher judge grades every explanation (0-1: specific, accurate, concise).

Conditioning on the gold verdict isolates explanation quality from verdict accuracy, which
eval_model.py measures separately. Only scam/suspicious messages are used: those are the
ones users actually see an explanation for.
"""

import argparse
import asyncio
import json
import random
from pathlib import Path

from common import read_jsonl
from judge import Judge
from scorer import Scorer


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--n", type=int, default=150)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    rows = [r for r in read_jsonl(f"{args.data_dir}/test.jsonl") if r["verdict"] != "safe"]
    random.Random(args.seed).shuffle(rows)  # same seed -> same messages for every model compared
    rows = rows[: args.n]

    scorer = Scorer(args.model)
    reasons = [scorer.reason(r["prompt"], r["verdict"]) for r in rows]
    judge = Judge()
    scores = asyncio.run(judge.score_many([(r["prompt"], r["verdict"], reason) for r, reason in zip(rows, reasons)]))

    graded = [s for s in scores if s is not None]
    report = {
        "model": args.model,
        "n": len(rows),
        "graded": len(graded),
        "mean_quality": sum(graded) / len(graded),
        "share_perfect": sum(s >= 0.95 for s in graded) / len(graded),
        "share_poor": sum(s <= 0.5 for s in graded) / len(graded),
        "samples": [
            {"verdict": r["verdict"], "reason": reason, "score": s, "input": r["prompt"][:240]}
            for r, reason, s in list(zip(rows, reasons, scores))[:30]
        ],
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, indent=2))
    print(f"{args.model}: explanation quality {report['mean_quality']:.3f} "
          f"(perfect {report['share_perfect']:.0%}, poor {report['share_poor']:.0%}, n={len(graded)})")


if __name__ == "__main__":
    main()
