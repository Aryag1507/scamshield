# ScamShield

A browser extension and website that warns you about scam emails, texts, and web pages, powered by a language model trained specifically for scam detection and served from the cloud.

> Paste or open a message → **scam / suspicious / safe** + one sentence explaining the warning signs.

## Why a custom model

General chatbots can spot scams if you copy-paste into them. Nobody does that. ScamShield runs *passively* on every email and page you open, so it has to be fast, cheap per request, and tuned to a strict false-positive budget (a detector that cries wolf gets uninstalled). That calls for a small specialist model, trained and calibrated for exactly this task.

## Architecture

```mermaid
flowchart LR
    subgraph Users
        EXT[Chrome extension<br/>Gmail · Outlook · any page]
        WEB[Website<br/>paste a message, works on phones]
        MAIL[Forward-to-check<br/>check@ inbox]
    end
    API[Inference API<br/>FastAPI + fine-tuned model<br/>cloud GPU]
    EXT --> API
    WEB --> API
    MAIL --> API

    subgraph Training [Training pipeline · Modal cloud GPUs]
        PUB[Public datasets<br/>~23k emails + SMS] --> TEACH
        TAX[Scam taxonomy<br/>47 categories × 4 channels] --> TEACH
        TEACH[Teacher LLM<br/>labels + reasons + synthetic modern scams] --> SPLIT[Group-aware split<br/>+ held-out scam categories]
        SPLIT --> SFT[Full fine-tune<br/>Qwen2.5-0.5B] --> GRPO[GRPO RL<br/>teacher-judged reward] --> EVAL[Eval + threshold tuning<br/>at 1% FPR]
    end
    EVAL -->|model + thresholds| HUB[(Hugging Face Hub)] --> API
```

## Training pipeline (`training/`)

| Step | Script | What it does |
|---|---|---|
| 1 | `build_public.py` | Downloads 3 public phishing/spam datasets, normalizes, dedupes across datasets → 22,954 examples |
| 2 | `teacher.py synth` | Generates modern scams (toll texts, pig butchering, task scams, MFA-code theft, wallet drainers…) **and hard negatives** (real OTPs, real bank alerts, real recruiters) via the Batches API |
| 3 | `teacher.py label` | Re-labels noisy public data into 3 classes with a one-sentence reason (SMS marketing ≠ scam) |
| 4 | `split.py` | Group-aware train/val/test split; 3 whole scam categories held out to measure generalization to **unseen scam types** |
| 5 | `train_sft.py` | Full-parameter SFT, loss on the answer only, rare-class rebalancing |
| 6 | `eval_model.py` | Verdict = softmax over verdict log-likelihoods (calibrated, not sampled); thresholds tuned on val for max scam recall at ≤1% false positives; reports precision/recall/AUC per channel and on unseen categories |
| 7 | `modal_app.py` | Runs 5–6 on cloud H100/L4 GPUs, tracks runs in W&B, pushes the model to the Hugging Face Hub |

### Cost tiers

Start small, check the results, then scale up. Every teacher command prints its cost estimate and asks before spending anything.

| | Starter | Full |
|---|---|---|
| Teacher data | Haiku 5.5, ~1.6k synthetic + 4k relabeled | Opus 5.5 synthetic + Haiku labels, ~4k + 12k |
| Teacher cost (one-time) | **~$0.55** | ~$17 |
| Training GPU | L4, ~$0.20–0.50 per run | H100, ~$1–3 per run |
| Paid from | Modal's free monthly credits | Modal credits / ~$5 |

W&B (training curves) and Hugging Face Hub (model hosting) are free. The Anthropic API needs prepaid credits; the starter run uses well under a dollar of them.

### Run it (starter)

```bash
cd training
pip install -r requirements.txt
export ANTHROPIC_API_KEY=...

python build_public.py
python teacher.py synth submit --model claude-haiku-5-5 --variants 2
python teacher.py label submit --model claude-haiku-5-5 --limit 4000
# ...batches usually finish within an hour...
python teacher.py synth collect
python teacher.py label collect
python split.py

modal run modal_app.py --stage upload
modal run modal_app.py --stage baseline                       # untuned model, for comparison
modal run modal_app.py --stage train --run-name sft-0.5b-v1   # L4 GPU
modal run modal_app.py --stage eval  --run-name sft-0.5b-v1
modal run modal_app.py --stage push  --run-name sft-0.5b-v1 --repo-id <you>/scamshield-0.5b
```

### Scaling up

Re-run the teacher at full size (Opus writes better scams; labeling is easy enough for Haiku), re-split, and train on an H100:

```bash
python teacher.py synth submit --model claude-opus-5-5 --variants 5
python teacher.py label submit --model claude-haiku-5-5 --limit 12000
# collect both, then:
python split.py && modal run modal_app.py --stage upload
modal run modal_app.py --stage train --run-name sft-0.5b-v2 --gpu H100
```

Note: `submit` overwrites the saved batch ID for that job, so collect a batch before submitting the next one of the same kind.

## Results

Model: [huggingface.co/Aryag1507/scamshield-0.5b](https://huggingface.co/Aryag1507/scamshield-0.5b) (v2 live; v1 in the repo history)

Test set: 362 held-out messages (81 scams, 76 suspicious, 205 safe). **Unseen**: 115 scams from 3 scam types excluded from all training. Thresholds tuned on validation for ≤1% safe→scam. A scam counts as **warned** when the model says scam or suspicious, since both show the user a warning.

| Model | 3-way accuracy | Scams warned | Scams missed | Safe messages warned | Safe called scam | Unseen scams warned | Explanation quality |
|---|---|---|---|---|---|---|---|
| Qwen2.5-0.5B-Instruct (untrained) | 55.2% | 1.2% | 98.8% | 2.4% | 1.95% | 0.0% | — |
| v1: SFT | 83.1% | 98.8% | 1.2% | 8.8% | 1.95% | 100% | 0.773 |
| **v2: SFT + GRPO (live)** | **85.1%** | **97.5%** | **2.5%** | **3.9%** | **0.98%** | **97.4%** | **0.785** |

Explanation quality: mean 0-1 score from a teacher judge (specific / accurate / concise) on 150 test scams, each model explaining the gold verdict.

Caveats, honestly stated:
- Test sets are small (81 scams): one message moves a rate by ~1.2 points.
- Unseen-category messages come from the same teacher model as the training data, so they likely overstate real-world generalization. A hand-collected set of real scams is on the roadmap.
- Many remaining errors are scam ↔ suspicious on 2000s-era spam, where the labels themselves are debatable.

### Stage 2: GRPO (`training/grpo.py`, `training/judge.py`)

Group Relative Policy Optimization, written from scratch on top of the SFT model:

1. Sample 8 training messages (balanced across verdicts); generate 8 answers each at temperature 1.0.
2. **Reward** each answer: verdict +1 correct, +0.25 scam↔suspicious, −1 wrong, **−1.5 for calling a safe message a scam**, −1 unparseable; plus 0.5 × an explanation score from a teacher judge (Claude Haiku 5.5, structured output, run concurrently and memoized).
3. **Advantage** = (reward − group mean) / group std, comparing each answer only with its siblings, so no value network is needed.
4. **Loss**: policy gradient on completion tokens + k3 KL penalty (0.04) to the frozen SFT model; the LM head is applied only to completion positions.

150 steps, 9,600 graded answers, 0 judge failures, one L4 GPU (~55 min, ~$1 judge cost).

**What it did:** the policy learned exactly the trade-off the reward encoded. A false alarm cost more than hedging a real scam to "suspicious", so false warnings on legitimate messages fell from **8.8% to 3.9%** and accuracy rose 2 points, while slightly more scams were hedged or missed (missed 1.2% → 2.5%). For an extension that checks every message, fewer false alarms was the better trade, so v2 is live. Explanation quality rose during training on sampled answers (0.645 → 0.717) but only slightly under greedy decoding (0.773 → 0.785); a next iteration would lower the hedging credit and weight the explanation reward more.

Engineering notes: a fresh `asyncio.run()` per step crashed on step 2 of the first run (the judge's semaphore binds to the first event loop that makes a caller wait; the local test made too few calls to trigger it). Fixed with one event loop per run, and reproduced and verified locally with a contended fake judge before relaunching.

## Serving (`serve/`)

FastAPI app running the model on CPU, deployed on Modal: `https://aryag1507--scamshield-api-web.us-east.modal.run`.

| Endpoint | What it does |
|---|---|
| `POST /check` | Verdict + probabilities from one forward pass (~1s). `include_reason=false` skips the explanation. |
| `POST /reason/stream` | The one-sentence explanation as Server-Sent Events, token by token (first words in ~0.7s). |
| `POST /reason` | Same explanation, non-streaming. |

### Inference engine (`serve/engine.py`)

One thread owns the model; requests never take a global lock.

- **Verdicts are micro-batched:** every verdict waiting when the scheduler wakes is scored in one forward pass.
- **Explanations use continuous batching:** each sequence keeps its own KV cache; every iteration prefills newly arrived requests, then advances *all* running sequences one token in a single batched forward pass (caches left-padded to a common length, decoded together, split back). A request arriving mid-generation joins the next step. Verified token-for-token identical to sequential greedy generation, including staggered arrivals.
- **Streaming:** tokens are emitted as produced (multi-byte characters held until complete) and served as SSE.
- **Shared prompt cache for verdicts:** the message is encoded once and its KV cache reused for the `scam` / `suspicious` / `safe` continuations (identical scores, ~2× faster than three passes).

### Benchmarks (2-vCPU cloud machine, `modal run serve/modal_serve.py::benchmark`)

| Setup | Accuracy | Verdict p50 | Verdict p90 | Peak memory |
|---|---|---|---|---|
| fp32, each verdict scored separately (3 passes) | 82.7% | 3.1s | 12.0s | 4.1GB |
| **fp32, shared prompt cache** (served) | **82.7%** | **1.6s** | **4.9s** | **3.2GB** |
| bf16, shared cache | 82.7% | 8.4s | 30.5s | 3.5GB |
| dynamic int8 (weights + activations) | 34.7% | 1.8s | 7.5s | 6.0GB |
| dynamic int8, output head kept fp32 | 36.0% | 0.9s | 3.1s | 5.2GB |

8 explanations at once: **37.3s with continuous batching vs 54.7s one after another (1.47×)**. On 2 vCPUs, each request's prefill (reading the whole message) is compute-bound and can't be shared; the decode phase is what batching speeds up.

Findings:
- **Dynamic int8 breaks this model.** Small Qwen models have a few huge-magnitude activation channels; int8 activations can't represent them (accuracy 83% → 35%).
- **Weight-only int8** (`serve/quant.py`: int8 weights with per-channel scales, fp32 activations, tied embedding/LM head sharing one int8 matrix) fixes accuracy and cuts weights 3.9×, and is fast on ARM. **But on the deployment CPU (AVX2 only, no AVX-512/VNNI) PyTorch's fused int8 kernel is 6× slower at decode and 46× slower at prefill than fp32** (`modal run serve/modal_serve.py::kernels`). Production stays fp32; `WEIGHTS=int8` is available for hardware with fast int8 kernels.
- **bf16 is ~5× slower** without native bf16 instructions.

## Roadmap

- [x] Data pipeline, teacher generation, group-aware splits
- [x] Cloud SFT + calibrated evaluation
- [x] First training run + results table
- [x] RL post-training (GRPO) with a teacher-judged explanation reward
- [x] Own inference engine: continuous batching, streaming, shared prompt cache
- [ ] Real-world test set: hand-collected recent scams + legitimate messages
- [ ] GRPO v3: less credit for hedging scams, more weight on explanation quality
- [x] Inference API (`serve/`): FastAPI on CPU, deployed on Modal
- [x] Website with paste-to-check (`web/`)
- [ ] Website deployed on Vercel
- [x] Chrome extension (`extension/`): banner in Gmail / Outlook, right-click check on any page, toolbar popup
- [ ] Publish the extension to the Chrome Web Store
- [ ] Forward-to-check email address
- [ ] Feedback button → logged false positives/negatives → next training round
