# Build from the repo root:  docker build -f serve/Dockerfile -t scamshield-api .
FROM python:3.11-slim

ENV PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models \
    TOKENIZERS_PARALLELISM=false

WORKDIR /app

# CPU-only torch keeps the image ~1GB smaller than the default CUDA build.
RUN pip install torch==2.8.0 --index-url https://download.pytorch.org/whl/cpu
COPY serve/requirements.txt .
RUN pip install -r requirements.txt

# Bake the model into the image: fast cold starts, no runtime dependency on the Hub.
ARG SCAMSHIELD_MODEL=Aryag1507/scamshield-0.5b
ARG SCAMSHIELD_REVISION=e18864cb6ce0e1a974d48f01b9cf52bf1287136a
ENV SCAMSHIELD_MODEL=${SCAMSHIELD_MODEL} SCAMSHIELD_REVISION=${SCAMSHIELD_REVISION}
RUN python -c "import os; from huggingface_hub import snapshot_download; snapshot_download(os.environ['SCAMSHIELD_MODEL'], revision=os.environ['SCAMSHIELD_REVISION'], allow_patterns=['*.json', '*.safetensors', '*.txt', '*.jinja'])"

COPY training/common.py training/scorer.py serve/app.py serve/engine.py serve/quant.py ./

EXPOSE 8000
# No access log: it would record client IPs, which the privacy policy says aren't logged.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log"]
