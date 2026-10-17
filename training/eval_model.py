"""Evaluate a checkpoint (or the untuned base model, as a baseline).

1. Score val + test + test_unseen with Scorer.verdict_probs.
2. Tune thresholds on val: maximize scam recall subject to a false-positive budget
   (share of truly safe messages flagged as scam). A scam detector that cries wolf
   gets uninstalled, so FPR is the constraint and recall is the objective.
3. Report metrics on test and on the held-out scam categories; write metrics.json and
   thresholds.json next to the model so serving uses the same operating point.
"""

import argparse
import json
from collections import defaultdict
from pathlib import Path

from common import VERDICTS, read_jsonl
from scorer import Scorer, decide


def score_split(scorer: Scorer, rows: list[dict], batch_size: int) -> list[dict]:
    out = []
    for i in range(0, len(rows), batch_size):
        batch = rows[i : i + batch_size]
        for r, p in zip(batch, scorer.verdict_probs([r["prompt"] for r in batch])):
            out.append({**r, "probs": p})
        print(f"  scored {len(out)}/{len(rows)}", end="\r")
    print()
    return out


def auc(pos: list[float], neg: list[float]) -> float:
    """ROC-AUC via the rank-sum formulation (probability a random positive outranks a random negative)."""
    if not pos or not neg:
        return float("nan")
    ranked = sorted([(s, 1) for s in pos] + [(s, 0) for s in neg])
    rank_sum, i = 0.0, 0
    while i < len(ranked):
        j = i
        while j < len(ranked) and ranked[j][0] == ranked[i][0]:
            j += 1
        avg_rank = (i + j + 1) / 2  # 1-based average rank for ties
        rank_sum += avg_rank * sum(label for _, label in ranked[i:j])
        i = j
    return (rank_sum - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))


def metrics(scored: list[dict], t_scam: float, t_susp: float) -> dict:
    preds = [decide(r["probs"], t_scam, t_susp) for r in scored]
    gold = [r["verdict"] for r in scored]
    m = {"n": len(scored), "accuracy": sum(p == g for p, g in zip(preds, gold)) / max(1, len(scored))}
    for v in VERDICTS:
        tp = sum(p == v and g == v for p, g in zip(preds, gold))
        fp = sum(p == v and g != v for p, g in zip(preds, gold))
        fn = sum(p != v and g == v for p, g in zip(preds, gold))
        prec, rec = tp / max(1, tp + fp), tp / max(1, tp + fn)
        m[v] = {"precision": prec, "recall": rec, "f1": 2 * prec * rec / max(1e-9, prec + rec), "support": tp + fn}
    safe_n = sum(g == "safe" for g in gold)
    m["safe_flagged_as_scam_rate"] = sum(p == "scam" and g == "safe" for p, g in zip(preds, gold)) / max(1, safe_n)
    m["scam_auc"] = auc([r["probs"]["scam"] for r in scored if r["verdict"] == "scam"], [r["probs"]["scam"] for r in scored if r["verdict"] != "scam"])

    by_channel = defaultdict(lambda: [0, 0])
    for p, r in zip(preds, scored):
        if r["verdict"] == "scam":
            by_channel[r["channel"]][0] += p == "scam"
            by_channel[r["channel"]][1] += 1
    m["scam_recall_by_channel"] = {c: hit / n for c, (hit, n) in by_channel.items()}
    return m


def tune_thresholds(val: list[dict], max_fpr: float) -> tuple[float, float]:
    safe = sorted((r["probs"]["scam"] for r in val if r["verdict"] == "safe"), reverse=True)
    # Smallest scam threshold whose false-positive rate on safe messages stays within budget.
    # No upper cap: capping would silently break the FPR budget for an over-confident model.
    k = int(max_fpr * len(safe))
    t_scam = max(0.05, safe[k] + 1e-9 if k < len(safe) else 0.5)
    # Suspicious threshold: best 3-way accuracy on val given t_scam.
    best = max((metrics(val, t_scam, t)["accuracy"], t) for t in [x / 20 for x in range(1, 20)])
    return t_scam, best[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="checkpoint dir or Hugging Face model id")
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--max-fpr", type=float, default=0.01)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--limit", type=int, default=None, help="cap rows per split (smoke tests)")
    parser.add_argument("--reason-samples", type=int, default=25)
    args = parser.parse_args()

    scorer = Scorer(args.model)
    splits = {}
    for name in ("val", "test", "test_unseen"):
        path = Path(args.data_dir) / f"{name}.jsonl"
        if path.exists():
            print(f"scoring {name}")
            splits[name] = score_split(scorer, read_jsonl(path)[: args.limit], args.batch_size)

    t_scam, t_susp = tune_thresholds(splits["val"], args.max_fpr)
    report = {"model": args.model, "thresholds": {"scam": t_scam, "suspicious": t_susp, "max_fpr": args.max_fpr}}
    for name in ("test", "test_unseen"):
        if name in splits:
            report[name] = metrics(splits[name], t_scam, t_susp)

    # A few generated reasons, so a human can sanity-check explanation quality.
    report["samples"] = []
    for r in splits["test"][: args.reason_samples]:
        v = decide(r["probs"], t_scam, t_susp)
        report["samples"].append({"gold": r["verdict"], "pred": v, "p_scam": round(r["probs"]["scam"], 3), "reason": scorer.reason(r["prompt"], v), "input": r["prompt"][:300]})

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "metrics.json").write_text(json.dumps(report, indent=2))
    (out / "thresholds.json").write_text(json.dumps(report["thresholds"], indent=2))

    t = report["test"]
    print(f"\n== {args.model}")
    print(f"thresholds: scam>={t_scam:.3f}, scam+suspicious>={t_susp:.2f} (val FPR budget {args.max_fpr:.1%})")
    print(f"test: acc {t['accuracy']:.3f} | scam P {t['scam']['precision']:.3f} R {t['scam']['recall']:.3f} | AUC {t['scam_auc']:.3f} | safe->scam {t['safe_flagged_as_scam_rate']:.2%}")
    if "test_unseen" in report:
        print(f"unseen scam categories: recall {report['test_unseen']['scam']['recall']:.3f}")


if __name__ == "__main__":
    main()
