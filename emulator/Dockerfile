ARG EMULATOR_IMAGE=us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:7148297
FROM ${EMULATOR_IMAGE}
ARG EMULATOR_IMAGE

ARG EMULATOR_SYSTEM_IMAGE=system-images;android-34;google_apis;x86_64
ARG EMULATOR_PLATFORM=platforms;android-34

RUN set -eux; \
  SDKMANAGER_BIN="$(command -v sdkmanager || true)"; \
  AVDMANAGER_BIN="$(command -v avdmanager || true)"; \
  if [ -z "${SDKMANAGER_BIN}" ]; then \
    for candidate in \
      /android/sdk/cmdline-tools/latest/bin/sdkmanager \
      /android/sdk/cmdline-tools/*/bin/sdkmanager \
      /android/sdk/tools/bin/sdkmanager \
      /opt/android-sdk/cmdline-tools/latest/bin/sdkmanager \
      /opt/android-sdk/tools/bin/sdkmanager; do \
      if [ -x "${candidate}" ]; then SDKMANAGER_BIN="${candidate}"; break; fi; \
    done; \
  fi; \
  if [ -z "${AVDMANAGER_BIN}" ]; then \
    for candidate in \
      /android/sdk/cmdline-tools/latest/bin/avdmanager \
      /android/sdk/cmdline-tools/*/bin/avdmanager \
      /android/sdk/tools/bin/avdmanager \
      /opt/android-sdk/cmdline-tools/latest/bin/avdmanager \
      /opt/android-sdk/tools/bin/avdmanager; do \
      if [ -x "${candidate}" ]; then AVDMANAGER_BIN="${candidate}"; break; fi; \
    done; \
  fi; \
  if [ -z "${SDKMANAGER_BIN}" ] || [ -z "${AVDMANAGER_BIN}" ]; then \
    echo "Unable to locate sdkmanager/avdmanager in base image ${EMULATOR_IMAGE:-unknown}" >&2; \
    find /android /opt -maxdepth 6 -type f \( -name sdkmanager -o -name avdmanager \) 2>/dev/null || true; \
    exit 1; \
  fi; \
  yes | "${SDKMANAGER_BIN}" --licenses >/dev/null; \
  "${SDKMANAGER_BIN}" --channel=0 "${EMULATOR_SYSTEM_IMAGE}" "${EMULATOR_PLATFORM}"; \
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
