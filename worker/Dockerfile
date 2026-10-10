FROM python:3.12-slim

WORKDIR /app

# Install system dependencies (needed for instagrapi)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libffi-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for layer caching
COPY worker/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy the instagram_search module (shared with Vercel function)
COPY instagram_search.py /app/instagram_search.py

# Copy worker server
COPY worker/server.py /app/server.py

EXPOSE 8000

CMD ["python", "server.py"]
