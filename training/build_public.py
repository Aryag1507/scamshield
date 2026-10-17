"""Download public phishing/spam datasets, normalize them to one schema, and dedupe.

Output: data/public.jsonl with rows {id, text, channel, label, source}
  label is the dataset's binary label ("scam" or "safe"). These labels are noisy
  (e.g. SMS marketing spam is not a scam), so label_reasons.py re-labels them with
  the teacher model into scam / suspicious / safe and adds a reason.
"""

import argparse
import json
import urllib.request

import pandas as pd

from common import DATA_DIR, dedupe_key, normalize_whitespace, write_jsonl

HF = "https://huggingface.co/datasets"
SOURCES = {
    "phishing_email": f"{HF}/zefang-liu/phishing-email-dataset/resolve/main/Phishing_Email.csv",
    "phishing_texts": f"{HF}/ealvaradob/phishing-dataset/resolve/main/texts.json",
    "sms_spam": f"{HF}/ucirvine/sms_spam/resolve/main/plain_text/train-00000-of-00001.parquet",
}

MIN_CHARS, MAX_CHARS = 20, 20_000


def download(name: str, url: str) -> str:
    dest = DATA_DIR / "raw" / url.rsplit("/", 1)[-1]
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        print(f"downloading {name} ...")
        urllib.request.urlretrieve(url, dest)
    return str(dest)


def load_all() -> list[dict]:
    # Order matters: phishing_texts re-packages the SMS corpus, so SMS loads first and
    # dedupe keeps those copies with the correct "sms" channel.
    rows = []

    df = pd.read_parquet(download("sms_spam", SOURCES["sms_spam"]))
    for text, label in zip(df["sms"], df["label"]):
        rows.append({"text": text, "channel": "sms", "label": "scam" if label == 1 else "safe", "source": "sms_spam"})

    df = pd.read_csv(download("phishing_email", SOURCES["phishing_email"]))
    for text, kind in zip(df["Email Text"], df["Email Type"]):
        rows.append({"text": text, "channel": "email", "label": "scam" if kind == "Phishing Email" else "safe", "source": "phishing_email"})

    with open(download("phishing_texts", SOURCES["phishing_texts"])) as f:
        for item in json.load(f):
            rows.append({"text": item["text"], "channel": "email", "label": "scam" if item["label"] == 1 else "safe", "source": "phishing_texts"})

    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(DATA_DIR / "public.jsonl"))
    args = parser.parse_args()

    rows = load_all()
    seen: dict[str, str] = {}
    kept, dropped_len, dropped_dup, dropped_conflict = [], 0, 0, set()
    for row in rows:
        if not isinstance(row["text"], str):
            dropped_len += 1
            continue
        text = normalize_whitespace(row["text"])
        if not MIN_CHARS <= len(text) <= MAX_CHARS:
            dropped_len += 1
            continue
        key = dedupe_key(text)
        if key in seen:
            dropped_dup += 1
            if seen[key] != row["label"]:
                dropped_conflict.add(key)  # same text, different labels across datasets
            continue
        seen[key] = row["label"]
        kept.append({"id": key[:16], **row, "text": text})

    kept = [r for r in kept if dedupe_key(r["text"]) not in dropped_conflict]
    write_jsonl(args.out, kept)

    counts = pd.DataFrame(kept).groupby(["source", "label"]).size()
    print(f"loaded {len(rows)}, kept {len(kept)} (dropped {dropped_len} by length, {dropped_dup} duplicates, {len(dropped_conflict)} label conflicts)")
    print(counts.to_string())


if __name__ == "__main__":
    main()
