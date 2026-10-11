FROM python:3.12-slim

WORKDIR /app

# Install system dependencies including ffmpeg for audio processing.
# ffmpeg is used by the reel transcription pipeline (download + denoise).
# static-ffmpeg also bundles its own binary as a fallback.
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libffi-dev \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Whisper model cache directory — persists within a running container.
ENV WHISPER_MODEL_DIR=/app/whisper_models
RUN mkdir -p /app/whisper_models

# Copy requirements first for layer caching
COPY worker/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# For Dockerfile-based builds, upgrade instagrapi at image build time.
# The startup script (start.sh) also upgrades at runtime for Railpack builds.
RUN pip install --quiet --upgrade --no-cache-dir instagrapi

# Copy shared instagram_search module (repo root)
COPY instagram_search.py /app/instagram_search.py

# Copy worker server and test script
COPY worker/server.py /app/server.py
COPY worker/test_ig.py /app/test_ig.py

EXPOSE 8000

CMD ["python", "server.py"]
