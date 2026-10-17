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
        SPLIT --> SFT[Full fine-tune<br/>Qwen2.5-0.5B] --> EVAL[Eval + threshold tuning<br/>at 1% FPR]
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

Model: [huggingface.co/Aryag1507/scamshield-0.5b](https://huggingface.co/Aryag1507/scamshield-0.5b)

Starter run: 4,544 training examples (Haiku teacher), full SFT of Qwen2.5-0.5B-Instruct, 2 epochs, one L4 GPU (~28 min). Test set: 362 held-out messages; unseen categories: 115 scams from 3 scam types never seen in training. Threshold tuned on validation for ≤1% safe→scam false positives.

| Model | Scam recall | Scam precision | AUC | Safe flagged as scam | 3-way accuracy | Unseen-category recall |
|---|---|---|---|---|---|---|
| Qwen2.5-0.5B-Instruct (no tuning) | 0.0% | — | 0.509 | 1.5% | 55.5% | 0.0% |
| **ScamShield-0.5B v1 (SFT)** | **85.2%** | **72.6%** | **0.958** | **2.4%** | **81.5%** | **99.1%** |

Caveats, honestly stated:
- The FPR budget is set on a small validation set (187 safe messages, so 1% ≈ 2 messages); on test it landed at 2.4% (5 of 205). More validation data will tighten this.
- Unseen-category messages come from the same teacher model as training data, so 99.1% likely overstates real-world generalization. A hand-collected set of real scams is on the roadmap.
- Most remaining errors are scam ↔ suspicious on 2000s-era spam, where the labels themselves are debatable.

## Roadmap

- [x] Data pipeline, teacher generation, group-aware splits
- [x] Cloud SFT + calibrated evaluation
- [x] First training run + results table
- [ ] Real-world test set: hand-collected recent scams + legitimate messages
- [ ] Preference tuning (DPO) on reasons the teacher grades as vague
- [ ] Inference API (`serve/`), deployed on cloud GPU with autoscaling
- [ ] Website with paste-to-check (`web/`)
- [ ] Chrome extension for Gmail / Outlook / any page (`extension/`), published to the Chrome Web Store
- [ ] Forward-to-check email address
- [ ] Feedback button → logged false positives/negatives → next training round
