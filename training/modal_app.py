"""Run training and evaluation on Modal cloud GPUs.

One-time setup:
  modal token new
  modal secret create huggingface-secret HF_TOKEN=hf_...  # write token, for pushing models
  modal secret create wandb-secret WANDB_API_KEY=...      # training curves

Then, from training/:
  modal run modal_app.py --stage upload                   # push data/*.jsonl to the cloud volume
  modal run modal_app.py --stage baseline                 # eval the untuned base model
  modal run --detach modal_app.py --stage train --run-name sft-0.5b-v1      # L4 GPU (~$0.80/h); trains then evaluates
  modal run modal_app.py --stage train --run-name sft-0.5b-v2 --gpu H100    # ~5x faster, for the full dataset / bigger models
  modal run modal_app.py --stage eval  --run-name sft-0.5b-v1
  modal run modal_app.py --stage push  --run-name sft-0.5b-v1 --repo-id <hf-user>/scamshield-0.5b
"""

import subprocess
import time
from pathlib import Path

import modal

APP_NAME = "scamshield-training"
VOL_PATH = "/vol"
DATA_FILES = ("train.jsonl", "val.jsonl", "test.jsonl", "test_unseen.jsonl")

app = modal.App(APP_NAME)
vol = modal.Volume.from_name("scamshield", create_if_missing=True)
hf_cache = modal.Volume.from_name("hf-cache", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("torch==2.8.0", "transformers==4.57.1", "accelerate==1.10.1", "wandb==0.22.2", "huggingface_hub==0.35.3")
    .env({"HF_HOME": "/hf-cache", "TOKENIZERS_PARALLELISM": "false"})
    .add_local_python_source("common", "scorer", "train_sft", "eval_model")
)

volumes = {VOL_PATH: vol, "/hf-cache": hf_cache}
secrets = [modal.Secret.from_name("huggingface-secret"), modal.Secret.from_name("wandb-secret")]


def run(cmd: list[str], done_marker: str | None = None, grace_s: int = 300) -> None:
    """Run cmd. If done_marker appears and the process is still alive grace_s later, kill it:
    the real work is finished and something (in practice, W&B shutdown) is hanging."""
    print("+", " ".join(cmd))
    proc = subprocess.Popen(cmd)
    marker_seen_at = None
    while proc.poll() is None:
        if done_marker and marker_seen_at is None and Path(done_marker).exists():
            marker_seen_at = time.time()
        if marker_seen_at and time.time() - marker_seen_at > grace_s:
            print(f"work finished ({done_marker}) but process hung for {grace_s}s at exit; killing it")
            proc.kill()
            proc.wait()
            return
        time.sleep(10)
    if proc.returncode != 0:
        raise subprocess.CalledProcessError(proc.returncode, cmd)


@app.function(image=image, gpu="L4", volumes=volumes, secrets=secrets, timeout=6 * 3600)
def train(run_name: str, base_model: str, epochs: float, lr: float, max_train: int | None = None):
    cmd = ["python", "-m", "train_sft", "--base-model", base_model, "--data-dir", f"{VOL_PATH}/data",
           "--output-dir", f"{VOL_PATH}/runs/{run_name}", "--epochs", str(epochs), "--lr", str(lr)]
    if max_train:
        cmd += ["--max-train", str(max_train)]
    run(cmd, done_marker=f"{VOL_PATH}/runs/{run_name}/final/TRAINING_COMPLETE")
    vol.commit()
    # Evaluate in the same container, so results land on the volume with no laptop involved.
    run(["python", "-m", "eval_model", "--model", f"{VOL_PATH}/runs/{run_name}/final",
         "--data-dir", f"{VOL_PATH}/data", "--out-dir", f"{VOL_PATH}/runs/{run_name}/eval"])
    vol.commit()


@app.function(image=image, gpu="L4", volumes=volumes, secrets=secrets, timeout=3 * 3600)
def evaluate(model: str, out_dir: str, limit: int | None = None):
    vol.reload()
    cmd = ["python", "-m", "eval_model", "--model", model, "--data-dir", f"{VOL_PATH}/data", "--out-dir", out_dir]
    if limit:
        cmd += ["--limit", str(limit)]
    run(cmd)
    vol.commit()
    return Path(out_dir, "metrics.json").read_text()


@app.function(image=image, secrets=secrets, timeout=300)
def check_secrets() -> dict:
    """Report which expected env vars the secrets provide (presence only, never values)."""
    import os

    from huggingface_hub import HfApi

    status = {name: bool(os.environ.get(name)) for name in ("HF_TOKEN", "WANDB_API_KEY")}
    who = HfApi().whoami()
    status["hf_user"] = who["name"]
    status["hf_token_role"] = who.get("auth", {}).get("accessToken", {}).get("role")
    return status


@app.function(image=image, volumes=volumes, secrets=secrets, timeout=1800)
def push(run_name: str, repo_id: str, card: str):
    from huggingface_hub import HfApi

    vol.reload()
    final = f"{VOL_PATH}/runs/{run_name}/final"
    for name in ("metrics.json", "thresholds.json"):
        src = Path(VOL_PATH, "runs", run_name, "eval", name)
        if src.exists():
            Path(final, name).write_bytes(src.read_bytes())
    Path(final, "README.md").write_text(card)
    api = HfApi()
    api.create_repo(repo_id, exist_ok=True)
    api.upload_folder(folder_path=final, repo_id=repo_id,
                      ignore_patterns=["checkpoint-*", "optimizer.pt", "training_args.bin", "TRAINING_COMPLETE"])
    print(f"pushed https://huggingface.co/{repo_id}")


@app.local_entrypoint()
def main(stage: str, run_name: str = "sft-0.5b-v1", base_model: str = "Qwen/Qwen2.5-0.5B-Instruct",
         epochs: float = 2.0, lr: float = 2e-5, repo_id: str = "", max_train: int = 0, limit: int = 0,
         gpu: str = "L4"):
    data_dir = Path(__file__).parent / "data"
    if stage == "check":
        print(check_secrets.remote())
    elif stage == "upload":
        with vol.batch_upload(force=True) as batch:
            for name in DATA_FILES:
                batch.put_file(data_dir / name, f"/data/{name}")
        print(f"uploaded {', '.join(DATA_FILES)}")
    elif stage == "baseline":
        print(evaluate.remote(base_model, f"{VOL_PATH}/runs/baseline-{base_model.split('/')[-1]}", limit or None))
    elif stage == "train":
        # spawn (not remote): the call runs independently of this client, so with --detach
        # it survives the laptop sleeping or disconnecting. Training + eval run back to back.
        call = train.with_options(gpu=gpu).spawn(run_name, base_model, epochs, lr, max_train or None)
        print(f"spawned training call {call.object_id}: {call.get_dashboard_url()}")
    elif stage == "eval":
        call = evaluate.spawn(f"{VOL_PATH}/runs/{run_name}/final", f"{VOL_PATH}/runs/{run_name}/eval", limit or None)
        print(f"spawned eval call {call.object_id}: results -> {VOL_PATH}/runs/{run_name}/eval/metrics.json")
    elif stage == "push":
        assert repo_id, "--repo-id required"
        push.remote(run_name, repo_id, (Path(__file__).parent / "MODEL_CARD.md").read_text())
    else:
        raise SystemExit(f"unknown stage {stage}")
