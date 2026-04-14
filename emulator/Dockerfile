ARG EMULATOR_IMAGE=us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:7148297
FROM ${EMULATOR_IMAGE}

ARG EMULATOR_SYSTEM_IMAGE=system-images;android-34;google_apis;x86_64
ARG EMULATOR_PLATFORM=platforms;android-34

RUN set -eux; \
  SDKMANAGER_BIN="$(command -v sdkmanager || true)"; \
  AVDMANAGER_BIN="$(command -v avdmanager || true)"; \
  if [ -z "${SDKMANAGER_BIN}" ]; then SDKMANAGER_BIN="/android/sdk/cmdline-tools/latest/bin/sdkmanager"; fi; \
  if [ -z "${AVDMANAGER_BIN}" ]; then AVDMANAGER_BIN="/android/sdk/cmdline-tools/latest/bin/avdmanager"; fi; \
  yes | "${SDKMANAGER_BIN}" --licenses >/dev/null; \
  "${SDKMANAGER_BIN}" "${EMULATOR_SYSTEM_IMAGE}" "${EMULATOR_PLATFORM}"; \
  mkdir -p /root/.android; \
  touch /root/.android/repositories.cfg; \
  echo "no" | "${AVDMANAGER_BIN}" create avd --force --name Pixel2 --package "${EMULATOR_SYSTEM_IMAGE}" --device "pixel_5"

COPY start-emulator-with-turn.sh /usr/local/bin/start-emulator-with-turn.sh

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    openssl \
    jq \
    python3 \
  && rm -rf /var/lib/apt/lists/*
RUN chmod +x /usr/local/bin/start-emulator-with-turn.sh

ENTRYPOINT ["/usr/local/bin/start-emulator-with-turn.sh"]
