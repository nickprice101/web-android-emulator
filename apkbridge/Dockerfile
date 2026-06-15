FROM python:3.11-slim-trixie

RUN set -eux; \
    . /etc/os-release; \
    echo "deb http://deb.debian.org/debian ${VERSION_CODENAME}-backports main contrib" > /etc/apt/sources.list.d/backports.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends adb ca-certificates curl ffmpeg; \
    apt-get install -y --no-install-recommends -t "${VERSION_CODENAME}-backports" scrcpy; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /opt/apkbridge

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

ENV PYTHONPATH=/opt/apkbridge

ENTRYPOINT ["/opt/apkbridge/entrypoint.sh"]
