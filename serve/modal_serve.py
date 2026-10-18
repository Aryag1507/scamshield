"""Serve the ScamShield API on Modal CPU containers, and benchmark CPU inference.

The container is sized like a small VPS (2 vCPU, 4GB) so latency numbers carry over to
a ~$5/month server. Scales to zero when idle; the model is baked into the image.

From serve/:
  modal run modal_serve.py::benchmark            # compare inference setups: latency, memory, agreement
  modal deploy modal_serve.py                    # public HTTPS endpoint
"""

import json
import os
import random
import time
from pathlib import Path

import modal

MODEL_ID = "Aryag1507/scamshield-0.5b"
# Pinned Hub commit. The model is baked into the image and Modal caches image layers, so
# changing this is what forces a rebuild with new weights (and makes deploys reproducible).
MODEL_REVISION = "e18864cb6ce0e1a974d48f01b9cf52bf1287136a"  # v2: SFT + GRPO (v1 SFT: f7c54706...)
CPU, MEMORY_MB = 2.0, 6144  # fp32 peaks ~3.2GB RSS; leave headroom
HERE = Path(__file__).parent


def download_model():
    from huggingface_hub import snapshot_download

    snapshot_download(MODEL_ID, revision=os.environ["SCAMSHIELD_REVISION"], allow_patterns=["*.json", "*.safetensors", "*.txt", "*.jinja"])


image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("torch==2.8.0", index_url="https://download.pytorch.org/whl/cpu")
    .pip_install_from_requirements(str(HERE / "requirements.txt"))
    .env({"HF_HOME": "/models", "TOKENIZERS_PARALLELISM": "false", "SCAMSHIELD_MODEL": MODEL_ID, "SCAMSHIELD_REVISION": MODEL_REVISION})
    .run_function(download_model)
    .add_local_file(HERE / "app.py", "/root/app.py")
    .add_local_file(HERE / "engine.py", "/root/engine.py")
    .add_local_file(HERE / "quant.py", "/root/quant.py")
    .add_local_file(HERE.parent / "training" / "common.py", "/root/common.py")
    .add_local_file(HERE.parent / "training" / "scorer.py", "/root/scorer.py")
)

app = modal.App("scamshield-api")


@app.function(image=image, cpu=CPU, memory=MEMORY_MB, scaledown_window=300, max_containers=2)
@modal.concurrent(max_inputs=8)
@modal.asgi_app()
def web():
    from app import app as fastapi_app

    return fastapi_app


@app.function(image=image, cpu=CPU, memory=8192, timeout=3600)
def bench(variant: str, rows: list[dict], reason_samples: int = 10) -> dict:
    """Time one inference setup on a fresh 2-vCPU container. Memory is requested generously
    so a heavy variant can finish and report its true peak instead of being OOM-killed."""
    import resource

    import torch
    from huggingface_hub import snapshot_download

    from scorer import Scorer

    torch.set_num_threads(int(CPU))
    path = snapshot_download(MODEL_ID, revision=MODEL_REVISION, allow_patterns=["*.json", "*.safetensors", "*.txt", "*.jinja"])
    dtype = torch.bfloat16 if variant == "bf16" else torch.float32
    scorer = Scorer(path, device="cpu", dtype=dtype)
    if variant == "int8-weight-only":
        from quant import quantize_model_int8

        quantize_model_int8(scorer.model)
        import gc

        gc.collect()

    scorer.verdict_probs([rows[0]["prompt"]])  # warm-up
    # Steady-state resident memory once the model is ready (peak RSS also counts the fp32
    # load that int8 quantizes from; a server could quantize offline and load int8 directly).
    steady_rss_mb = next(int(line.split()[1]) // 1024 for line in open("/proc/self/status") if line.startswith("VmRSS"))
    probs, verdict_ms = [], []
    for r in rows:
        start = time.perf_counter()
        probs.append(scorer.verdict_probs([r["prompt"]])[0])
        verdict_ms.append((time.perf_counter() - start) * 1000)
    reason_ms = []
    for r in rows[:reason_samples]:
        start = time.perf_counter()
        scorer.reason(r["prompt"], "scam")
        reason_ms.append((time.perf_counter() - start) * 1000)
    verdict_ms.sort()

    # Continuous batching: 8 explanations requested at once vs. the same 8 one after another.
    from engine import Engine

    texts = [scorer.chat_prefix(r["prompt"]) + "scam\nReason:" for r in rows[:8]]
    engine = Engine(scorer, max_batch=8)
    start = time.perf_counter()
    for t in texts:
        engine.generate(t).result()
    sequential_s = time.perf_counter() - start
    start = time.perf_counter()
    futures = [engine.generate(t) for t in texts]
    for f in futures:
        f.result()
    concurrent_s = time.perf_counter() - start

    return {
        "sequential_8_reasons_s": round(sequential_s, 1),
        "concurrent_8_reasons_s": round(concurrent_s, 1),
        "variant": variant,
        "probs": probs,
        "verdict_ms_p50": round(verdict_ms[len(verdict_ms) // 2]),
        "verdict_ms_p90": round(verdict_ms[int(len(verdict_ms) * 0.9)]),
        "verdict_ms_max": round(verdict_ms[-1]),
        "reason_ms_avg": round(sum(reason_ms) / len(reason_ms)),
        "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024),
        "steady_rss_mb": steady_rss_mb,
    }


@app.function(image=image, cpu=CPU, memory=MEMORY_MB, timeout=600)
def kernel_bench() -> dict:
    """Time one Qwen2.5-0.5B MLP-sized matmul: fp32 vs int8 weight-only, decode (M=1) and prefill (M=512)."""
    import torch

    torch.set_num_threads(int(CPU))
    flags = next((line for line in open("/proc/cpuinfo") if line.startswith("flags")), "")
    model_name = next((line.split(":", 1)[1].strip() for line in open("/proc/cpuinfo") if line.startswith("model name")), "?")
    out = {"cpu": model_name, "isa": [f for f in ("avx2", "avx512f", "avx512_vnni", "avx512_bf16", "amx_int8", "amx_bf16") if f" {f}" in flags]}
    w = torch.randn(4864, 896)
    scale = (w.abs().amax(dim=1) / 127).clamp(min=1e-8)
    q = torch.round(w / scale[:, None]).clamp(-127, 127).to(torch.int8)
    for m in (1, 512):
        x = torch.randn(m, 896)
        for name, fn in (("fp32", lambda: x @ w.T), ("int8", lambda: torch.ops.aten._weight_int8pack_mm(x, q, scale))):
            fn()
            reps = 50 if m == 1 else 5
            start = time.perf_counter()
            for _ in range(reps):
                fn()
            out[f"{name}_M{m}_ms"] = round((time.perf_counter() - start) / reps * 1000, 3)
    return out


@app.local_entrypoint()
def kernels():
    print(json.dumps(kernel_bench.remote(), indent=2))


@app.local_entrypoint()
def benchmark(n: int = 150, variants: str = "fp32,int8-weight-only"):
    from scorer import decide  # local import: training/ is on sys.path via PYTHONPATH

    data = HERE.parent / "training" / "data"
    rows = [json.loads(line) for line in open(data / "test.jsonl")]
    random.Random(0).shuffle(rows)
    rows = rows[:n]
    t = json.loads((data.parent / "results" / "sft-0.5b-v1_metrics.json").read_text())["thresholds"]
    names = variants.split(",")
    # return_exceptions: one variant timing out must not discard the others' results.
    outcomes = list(bench.starmap([(v, rows) for v in names], return_exceptions=True))
    results = {}
    for name, r in zip(names, outcomes):
        if isinstance(r, BaseException):
            print(f"{name:16s} FAILED: {type(r).__name__}: {str(r)[:120]}")
        else:
            results[name] = r

    ref = results.get("fp32")
    print(f"{'variant':16s} {'acc':>6s} {'agree':>6s} {'max dp':>7s} {'p50 ms':>7s} {'p90 ms':>7s} {'max ms':>7s} {'reason':>7s} {'peakMB':>7s} {'steadyMB':>8s}")
    for v, r in results.items():
        verdicts = [decide(p, t["scam"], t["suspicious"]) for p in r["probs"]]
        acc = sum(a == row["verdict"] for a, row in zip(verdicts, rows)) / len(rows)
        if ref:
            ref_v = [decide(p, t["scam"], t["suspicious"]) for p in ref["probs"]]
            agree = sum(a == b for a, b in zip(verdicts, ref_v)) / len(rows)
            dp = max(abs(a["scam"] - b["scam"]) for a, b in zip(r["probs"], ref["probs"]))
        else:
            agree, dp = float("nan"), float("nan")
        print(f"{v:16s} {acc:6.1%} {agree:6.1%} {dp:7.3f} {r['verdict_ms_p50']:7d} {r['verdict_ms_p90']:7d} {r['verdict_ms_max']:7d} {r['reason_ms_avg']:7d} {r['peak_rss_mb']:7d} {r['steady_rss_mb']:8d}"
              f"   8 reasons: sequential {r['sequential_8_reasons_s']}s, concurrent {r['concurrent_8_reasons_s']}s")
