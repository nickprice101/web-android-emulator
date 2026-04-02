FROM python:3.11-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends adb ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/apkbridge

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

ENV PYTHONPATH=/opt/apkbridge

ENTRYPOINT ["/opt/apkbridge/entrypoint.sh"]
