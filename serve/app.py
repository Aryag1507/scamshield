"""ScamShield inference API.

POST /check          {text, channel, sender?, subject?, explain?, include_reason?}
                  -> {verdict, probabilities, reason, model, latency_ms, cached}
POST /reason         {text, channel, sender?, subject?, verdict} -> {reason, latency_ms}
POST /reason/stream  same body; Server-Sent Events: {"delta": "..."} ... {"done": true, "reason": "..."}
GET  /health

All model work goes through engine.Engine, which owns the model on one thread: concurrent
verdicts are scored in one batch, and explanations are generated with continuous batching,
so simultaneous users share each forward pass instead of queueing behind a lock.

Interactive clients call /check with include_reason=false to show the verdict at once
(one forward pass, ~1s), then stream the explanation from /reason/stream. Simple clients
just call /check.

Privacy: message text is never logged or written to disk. Caches are keyed by a SHA-256 of
the input and hold only results; IPs are kept in memory for about a minute for rate limiting.
"""

import asyncio
import hashlib
import json
import logging
import os
import time
from collections import OrderedDict, defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import torch
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from huggingface_hub import snapshot_download
from pydantic import BaseModel, Field

from common import format_input
from engine import Engine
from scorer import Scorer, decide

MODEL_ID = os.environ.get("SCAMSHIELD_MODEL", "Aryag1507/scamshield-0.5b")
WEIGHTS = os.environ.get("WEIGHTS", "fp32")  # "fp32" or "int8" (weight-only, see quant.py)
RATE_LIMIT_PER_MIN = int(os.environ.get("RATE_LIMIT_PER_MIN", "30"))
CACHE_SIZE = int(os.environ.get("CACHE_SIZE", "4096"))
MAX_BATCH = int(os.environ.get("MAX_BATCH", "8"))
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",")]

log = logging.getLogger("scamshield")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

Channel = Literal["email", "sms", "chat", "webpage"]
Verdict = Literal["scam", "suspicious", "safe"]


class MessageIn(BaseModel):
    text: str = Field(min_length=1, max_length=50_000)
    channel: Channel = "email"
    sender: str | None = Field(default=None, max_length=320)
    subject: str | None = Field(default=None, max_length=500)


class CheckRequest(MessageIn):
    explain: bool = Field(default=False, description="Also generate a reason for messages judged safe")
    include_reason: bool = Field(default=True, description="False: return the verdict only; fetch the reason via /reason")


class ReasonRequest(MessageIn):
    verdict: Verdict


class CheckResponse(BaseModel):
    verdict: Verdict
    probabilities: dict[str, float]
    reason: str | None
    model: str
    latency_ms: int
    cached: bool


class ReasonResponse(BaseModel):
    reason: str
    latency_ms: int


class State:
    scorer: Scorer
    engine: Engine
    thresholds: dict
    # Touched only from the event loop thread (all endpoints are async), so no locks needed.
    verdicts: OrderedDict[str, dict] = OrderedDict()  # sha256(prompt) -> verdict + probabilities
    reasons: OrderedDict[str, str] = OrderedDict()  # sha256(verdict, prompt) -> reason
    hits: defaultdict[str, deque] = defaultdict(deque)
    last_sweep = 0.0


state = State()


def load_model() -> None:
    torch.set_num_threads(os.cpu_count() or 1)
    path = MODEL_ID if os.path.isdir(MODEL_ID) else snapshot_download(MODEL_ID, allow_patterns=["*.json", "*.safetensors", "*.txt", "*.jinja"])
    # fp32 activations always. Benchmarked on 2 vCPUs: bf16 was ~5x slower (no native bf16 on
    # most server CPUs) and dynamic int8 (int8 activations) collapsed accuracy to 36%.
    state.scorer = Scorer(path, device="cpu", dtype=torch.float32)
    if WEIGHTS == "int8":
        from quant import quantize_model_int8

        sizes = quantize_model_int8(state.scorer.model)
        log.info("int8 weights: %.0fMB -> %.0fMB", sizes["bytes_before"] / 1e6, sizes["bytes_after"] / 1e6)
    state.thresholds = json.loads(Path(path, "thresholds.json").read_text())
    state.scorer.verdict_probs([format_input("warm-up message", "sms")])  # first call is slow
    state.engine = Engine(state.scorer, max_batch=MAX_BATCH)
    log.info("loaded %s (%s weights, %d threads), thresholds %s", MODEL_ID, WEIGHTS, torch.get_num_threads(), state.thresholds)


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


def reason_input(prompt: str, verdict: str) -> str:
    # Must match Scorer.reason: the explanation is conditioned on the chosen verdict.
    return state.scorer.chat_prefix(prompt) + verdict + "\nReason:"


async def get_reason(prompt: str, verdict: str) -> str:
    key = digest(verdict, prompt)
    reason = lru_get(state.reasons, key)
    if reason is None:
        reason = await asyncio.wrap_future(state.engine.generate(reason_input(prompt, verdict)))
        lru_put(state.reasons, key, reason)
    return reason


@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL_ID, "weights": WEIGHTS}


@app.post("/check", response_model=CheckResponse)
async def check(req: CheckRequest, request: Request) -> CheckResponse:
    check_rate_limit(client_ip(request))
    start = time.perf_counter()
    prompt = format_input(req.text, req.channel, req.sender, req.subject)

    key = digest(prompt)
    result = lru_get(state.verdicts, key)
    cached = result is not None
    if not cached:
        probs = await asyncio.wrap_future(state.engine.verdict(prompt))
        verdict = decide(probs, state.thresholds["scam"], state.thresholds["suspicious"])
        result = {"verdict": verdict, "probabilities": {k: round(v, 4) for k, v in probs.items()}}
        lru_put(state.verdicts, key, result)
    wants_reason = req.include_reason and (result["verdict"] != "safe" or req.explain)
    reason = await get_reason(prompt, result["verdict"]) if wants_reason else None

    latency_ms = int((time.perf_counter() - start) * 1000)
    log.info("check channel=%s chars=%d verdict=%s cached=%s reason=%s latency_ms=%d",
             req.channel, len(req.text), result["verdict"], cached, wants_reason, latency_ms)
    return CheckResponse(**result, reason=reason, model=MODEL_ID, latency_ms=latency_ms, cached=cached)


@app.post("/reason", response_model=ReasonResponse)
async def reason(req: ReasonRequest, request: Request) -> ReasonResponse:
    check_rate_limit(client_ip(request))
    start = time.perf_counter()
    text = await get_reason(format_input(req.text, req.channel, req.sender, req.subject), req.verdict)
    latency_ms = int((time.perf_counter() - start) * 1000)
    log.info("reason channel=%s chars=%d verdict=%s latency_ms=%d", req.channel, len(req.text), req.verdict, latency_ms)
    return ReasonResponse(reason=text, latency_ms=latency_ms)


@app.post("/reason/stream")
async def reason_stream(req: ReasonRequest, request: Request) -> StreamingResponse:
    check_rate_limit(client_ip(request))
    prompt = format_input(req.text, req.channel, req.sender, req.subject)
    key = digest(req.verdict, prompt)

    async def events():
        start = time.perf_counter()
        cached = lru_get(state.reasons, key)
        if cached is not None:
            yield f"data: {json.dumps({'delta': cached})}\n\n"
            yield f"data: {json.dumps({'done': True, 'reason': cached})}\n\n"
            return
        loop = asyncio.get_running_loop()
        pieces: asyncio.Queue[str] = asyncio.Queue()
        # The engine thread calls on_token; hand each piece to this coroutine's loop safely.
        fut = state.engine.generate(reason_input(prompt, req.verdict), on_token=lambda p: loop.call_soon_threadsafe(pieces.put_nowait, p))
        done = asyncio.wrap_future(fut)
        while not (done.done() and pieces.empty()):
            getter = asyncio.ensure_future(pieces.get())
            await asyncio.wait({getter, done}, return_when=asyncio.FIRST_COMPLETED)
            if getter.done():
                yield f"data: {json.dumps({'delta': getter.result()})}\n\n"
            else:
                getter.cancel()
        text = done.result()
        lru_put(state.reasons, key, text)
        log.info("reason_stream channel=%s chars=%d verdict=%s latency_ms=%d",
                 req.channel, len(req.text), req.verdict, int((time.perf_counter() - start) * 1000))
        yield f"data: {json.dumps({'done': True, 'reason': text})}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
