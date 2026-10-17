"""ScamShield inference API.

POST /check   {text, channel, sender?, subject?, explain?, include_reason?}
           -> {verdict, probabilities, reason, model, latency_ms, cached}
POST /reason  {text, channel, sender?, subject?, verdict} -> {reason, latency_ms}
GET  /health

The verdict is one forward pass (~1-2s on 2 vCPUs); the reason is generated text (~5s).
Interactive clients call /check with include_reason=false to show the verdict at once,
then /reason to fill in the explanation. Simple clients just call /check.

Runs the fine-tuned model on CPU. The verdict comes from one forward pass (verdict
log-likelihoods, see scorer.py); the slower reason generation only runs for flagged
messages unless the caller asks for an explanation, so the common case (a safe email)
stays cheap.

Privacy: message text is never logged or written to disk. The response cache is keyed
by a SHA-256 of the input and holds only results.
"""

import hashlib
import json
import logging
import os
import threading
import time
from collections import OrderedDict, defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import torch
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from huggingface_hub import snapshot_download
from pydantic import BaseModel, Field

from common import format_input
from scorer import Scorer, decide

MODEL_ID = os.environ.get("SCAMSHIELD_MODEL", "Aryag1507/scamshield-0.5b")
RATE_LIMIT_PER_MIN = int(os.environ.get("RATE_LIMIT_PER_MIN", "30"))
CACHE_SIZE = int(os.environ.get("CACHE_SIZE", "4096"))
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",")]

log = logging.getLogger("scamshield")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


class CheckRequest(BaseModel):
    text: str = Field(min_length=1, max_length=50_000)
    channel: Literal["email", "sms", "chat", "webpage"] = "email"
    sender: str | None = Field(default=None, max_length=320)
    subject: str | None = Field(default=None, max_length=500)
    explain: bool = Field(default=False, description="Also generate a reason for messages judged safe")
    include_reason: bool = Field(default=True, description="False: return the verdict only; fetch the reason via /reason")


class ReasonRequest(BaseModel):
    text: str = Field(min_length=1, max_length=50_000)
    channel: Literal["email", "sms", "chat", "webpage"] = "email"
    sender: str | None = Field(default=None, max_length=320)
    subject: str | None = Field(default=None, max_length=500)
    verdict: Literal["scam", "suspicious", "safe"]


class ReasonResponse(BaseModel):
    reason: str
    latency_ms: int


class CheckResponse(BaseModel):
    verdict: Literal["scam", "suspicious", "safe"]
    probabilities: dict[str, float]
    reason: str | None
    model: str
    latency_ms: int
    cached: bool


class State:
    scorer: Scorer
    thresholds: dict
    # One model instance, one inference at a time: torch already uses every core for a
    # single forward pass, and concurrent generate() calls on one model aren't safe.
    lock = threading.Lock()
    verdicts: OrderedDict[str, dict] = OrderedDict()  # sha256(prompt) -> verdict + probabilities
    reasons: OrderedDict[str, str] = OrderedDict()  # sha256(verdict, prompt) -> reason
    hits: defaultdict[str, deque] = defaultdict(deque)
    last_sweep = 0.0


state = State()


def load_model() -> None:
    torch.set_num_threads(os.cpu_count() or 1)
    path = snapshot_download(MODEL_ID, allow_patterns=["*.json", "*.safetensors", "*.txt", "*.jinja"])
    # fp32 on purpose. Benchmarked on 2 vCPUs: bf16 was ~5x slower (no native bf16 on most
    # server CPUs) and dynamic int8 collapsed accuracy (36% vs 83%).
    state.scorer = Scorer(path, device="cpu", dtype=torch.float32)
    state.thresholds = json.loads(Path(path, "thresholds.json").read_text())
    state.scorer.verdict_probs([format_input("warm-up message", "sms")])  # first call is slow
    log.info("loaded %s on cpu (%d threads), thresholds %s", MODEL_ID, torch.get_num_threads(), state.thresholds)


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_model()
    yield


app = FastAPI(title="ScamShield API", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["GET", "POST"], allow_headers=["Content-Type"])


def client_ip(request: Request) -> str:
    # Behind a proxy (Modal, Caddy) the real client is the first X-Forwarded-For entry.
    forwarded = request.headers.get("x-forwarded-for")
    return forwarded.split(",")[0].strip() if forwarded else (request.client.host if request.client else "unknown")


def check_rate_limit(ip: str) -> None:
    now = time.monotonic()
    # Forget IPs idle for over a minute, so addresses are only held in memory briefly.
    if now - state.last_sweep > 60:
        for stale in [k for k, w in state.hits.items() if not w or now - w[-1] > 60]:
            del state.hits[stale]
        state.last_sweep = now
    window = state.hits[ip]
    while window and now - window[0] > 60:
        window.popleft()
    if len(window) >= RATE_LIMIT_PER_MIN:
        raise HTTPException(status_code=429, detail="Too many requests; try again in a minute.")
    window.append(now)


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_ID}


def lru_get(cache: OrderedDict, key: str):
    value = cache.get(key)
    if value is not None:
        cache.move_to_end(key)
    return value


def lru_put(cache: OrderedDict, key: str, value) -> None:
    cache[key] = value
    if len(cache) > CACHE_SIZE:
        cache.popitem(last=False)


def digest(*parts: str) -> str:
    return hashlib.sha256("\x00".join(parts).encode()).hexdigest()


def get_reason(prompt: str, verdict: str) -> str:
    """Caller holds state.lock."""
    key = digest(verdict, prompt)
    reason = lru_get(state.reasons, key)
    if reason is None:
        reason = state.scorer.reason(prompt, verdict)
        lru_put(state.reasons, key, reason)
    return reason


@app.post("/check", response_model=CheckResponse)
def check(req: CheckRequest, request: Request) -> CheckResponse:
    check_rate_limit(client_ip(request))
    start = time.perf_counter()
    prompt = format_input(req.text, req.channel, req.sender, req.subject)

    with state.lock:
        key = digest(prompt)
        result = lru_get(state.verdicts, key)
        cached = result is not None
        if not cached:
            probs = state.scorer.verdict_probs([prompt])[0]
            verdict = decide(probs, state.thresholds["scam"], state.thresholds["suspicious"])
            result = {"verdict": verdict, "probabilities": {k: round(v, 4) for k, v in probs.items()}}
            lru_put(state.verdicts, key, result)
        wants_reason = req.include_reason and (result["verdict"] != "safe" or req.explain)
        reason = get_reason(prompt, result["verdict"]) if wants_reason else None

    latency_ms = int((time.perf_counter() - start) * 1000)
    log.info("check channel=%s chars=%d verdict=%s cached=%s reason=%s latency_ms=%d",
             req.channel, len(req.text), result["verdict"], cached, wants_reason, latency_ms)
    return CheckResponse(**result, reason=reason, model=MODEL_ID, latency_ms=latency_ms, cached=cached)


@app.post("/reason", response_model=ReasonResponse)
def reason(req: ReasonRequest, request: Request) -> ReasonResponse:
    check_rate_limit(client_ip(request))
    start = time.perf_counter()
    prompt = format_input(req.text, req.channel, req.sender, req.subject)
    with state.lock:
        text = get_reason(prompt, req.verdict)
    latency_ms = int((time.perf_counter() - start) * 1000)
    log.info("reason channel=%s chars=%d verdict=%s latency_ms=%d", req.channel, len(req.text), req.verdict, latency_ms)
    return ReasonResponse(reason=text, latency_ms=latency_ms)
