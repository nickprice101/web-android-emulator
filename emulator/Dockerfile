ARG EMULATOR_IMAGE=us-docker.pkg.dev/android-emulator-268719/images/34-google-x64-no-metrics:34.1.19
FROM ${EMULATOR_IMAGE}

COPY start-emulator-with-turn.sh /usr/local/bin/start-emulator-with-turn.sh

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    openssl \
    jq \
    python3 \
  && rm -rf /var/lib/apt/lists/*
RUN chmod +x /usr/local/bin/start-emulator-with-turn.sh

ENTRYPOINT ["/usr/local/bin/start-emulator-with-turn.sh"]
