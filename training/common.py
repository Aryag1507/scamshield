"""Shared schema, prompt format, and text utilities for the ScamShield training pipeline."""

import hashlib
import json
import os
import re
from pathlib import Path

DATA_DIR = Path(os.environ.get("SCAMSHIELD_DATA_DIR", Path(__file__).parent / "data"))

# The three verdicts the model can give. "suspicious" covers messages that aren't
# clearly malicious but deserve caution (aggressive marketing, unverifiable requests).
VERDICTS = ("scam", "suspicious", "safe")
CHANNELS = ("email", "sms", "chat", "webpage")

# Inputs longer than this are truncated (keeping the start, where scam signals usually are).
MAX_INPUT_CHARS = 4000

STUDENT_SYSTEM_PROMPT = (
    "You are ScamShield, a scam and phishing detector. Read the message and reply with "
    "exactly two lines:\n"
    "line 1: one word - scam, suspicious, or safe\n"
    "line 2: Reason: <one sentence naming the concrete warning signs, or why it looks legitimate>"
)


def normalize_whitespace(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def dedupe_key(text: str) -> str:
    """Hash of the text with case, punctuation, and whitespace removed, so near-identical copies collide."""
    collapsed = re.sub(r"[\W_]+", "", text.lower())
    return hashlib.sha1(collapsed.encode()).hexdigest()


def format_input(text: str, channel: str, sender: str | None = None, subject: str | None = None) -> str:
    """The user-turn text the student model sees. Serving must build inputs with this same function."""
    lines = [f"Channel: {channel}"]
    if sender:
        lines.append(f"From: {sender}")
    if subject:
        lines.append(f"Subject: {subject}")
    body = text[:MAX_INPUT_CHARS]
    return "\n".join(lines) + "\n\n" + body


def format_target(verdict: str, reason: str) -> str:
    assert verdict in VERDICTS, verdict
    return f"{verdict}\nReason: {reason.strip()}"


def parse_target(output: str) -> tuple[str | None, str]:
    """Inverse of format_target, tolerant of small formatting drift from the model."""
    first, _, rest = output.strip().partition("\n")
    verdict = first.strip().lower().rstrip(".:")
    reason = rest.strip().removeprefix("Reason:").strip()
    return (verdict if verdict in VERDICTS else None), reason


def load_env(path: Path = Path(__file__).parent.parent / ".env") -> None:
    """Load KEY=VALUE lines from the repo's .env (gitignored) without overriding real env vars."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip().removeprefix("export ").strip(), value.strip().strip("'\""))


def read_jsonl(path: Path | str) -> list[dict]:
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def write_jsonl(path: Path | str, rows: list[dict]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
