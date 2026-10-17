"""Serve the ScamShield API on Modal CPU containers, and benchmark CPU inference.

The container is sized like a small VPS (2 vCPU, 4GB) so latency numbers carry over to
a ~$5/month server. Scales to zero when idle; the model is baked into the image.

From serve/:
  modal run modal_serve.py::benchmark            # compare inference setups: latency, memory, agreement
  modal deploy modal_serve.py                    # public HTTPS endpoint
"""

import json
import random
import time
from pathlib import Path

import modal

MODEL_ID = "Aryag1507/scamshield-0.5b"
CPU, MEMORY_MB = 2.0, 6144  # fp32 peaks ~3.2GB RSS; leave headroom
HERE = Path(__file__).parent


def download_model():
    from huggingface_hub import snapshot_download

    snapshot_download(MODEL_ID, allow_patterns=["*.json", "*.safetensors", "*.txt", "*.jinja"])


image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("torch==2.8.0", index_url="https://download.pytorch.org/whl/cpu")
    .pip_install_from_requirements(str(HERE / "requirements.txt"))
    .env({"HF_HOME": "/models", "TOKENIZERS_PARALLELISM": "false", "SCAMSHIELD_MODEL": MODEL_ID})
    .run_function(download_model)
    .add_local_file(HERE / "app.py", "/root/app.py")
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
    path = snapshot_download(MODEL_ID, allow_patterns=["*.json", "*.safetensors", "*.txt", "*.jinja"])
    dtype = torch.bfloat16 if variant == "bf16" else torch.float32
    scorer = Scorer(path, device="cpu", dtype=dtype)
    if variant == "int8-keep-head":
        # Quantize the transformer's Linear layers but keep the output head at full precision.
        qcfg = torch.ao.quantization.default_dynamic_qconfig
        spec = {name: qcfg for name, m in scorer.model.named_modules() if isinstance(m, torch.nn.Linear) and name != "lm_head"}
        scorer.model = torch.ao.quantization.quantize_dynamic(scorer.model, spec, dtype=torch.qint8)

    scorer.verdict_probs([rows[0]["prompt"]])  # warm-up
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
    return {
        "variant": variant,
        "probs": probs,
        "verdict_ms_p50": round(verdict_ms[len(verdict_ms) // 2]),
        "verdict_ms_p90": round(verdict_ms[int(len(verdict_ms) * 0.9)]),
        "verdict_ms_max": round(verdict_ms[-1]),
        "reason_ms_avg": round(sum(reason_ms) / len(reason_ms)),
        "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024),
    }


@app.local_entrypoint()
def benchmark(n: int = 150, variants: str = "fp32,bf16,int8-keep-head"):
    from scorer import decide  # local import: training/ is on sys.path via PYTHONPATH

    data = HERE.parent / "training" / "data"
    rows = [json.loads(line) for line in open(data / "test.jsonl")]
    random.Random(0).shuffle(rows)
    rows = rows[:n]
    t = json.loads((data.parent / "results" / "sft-0.5b-v1_metrics.json").read_text())["thresholds"]
    results = {r["variant"]: r for r in bench.starmap([(v, rows) for v in variants.split(",")])}

    ref = results.get("fp32")
    print(f"{'variant':16s} {'acc':>6s} {'agree':>6s} {'max dp':>7s} {'p50 ms':>7s} {'p90 ms':>7s} {'max ms':>7s} {'reason':>7s} {'RSS MB':>7s}")
    for v, r in results.items():
        verdicts = [decide(p, t["scam"], t["suspicious"]) for p in r["probs"]]
        acc = sum(a == row["verdict"] for a, row in zip(verdicts, rows)) / len(rows)
        if ref:
            ref_v = [decide(p, t["scam"], t["suspicious"]) for p in ref["probs"]]
            agree = sum(a == b for a, b in zip(verdicts, ref_v)) / len(rows)
            dp = max(abs(a["scam"] - b["scam"]) for a, b in zip(r["probs"], ref["probs"]))
        else:
            agree, dp = float("nan"), float("nan")
        print(f"{v:16s} {acc:6.1%} {agree:6.1%} {dp:7.3f} {r['verdict_ms_p50']:7d} {r['verdict_ms_p90']:7d} {r['verdict_ms_max']:7d} {r['reason_ms_avg']:7d} {r['peak_rss_mb']:7d}")
