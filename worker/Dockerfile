FROM python:3.12-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libffi-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for layer caching
COPY worker/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy shared instagram_search module (repo root)
COPY instagram_search.py /app/instagram_search.py

# Copy worker server and test script
COPY worker/server.py /app/server.py
COPY worker/test_ig.py /app/test_ig.py

EXPOSE 8000

CMD ["python", "server.py"]
