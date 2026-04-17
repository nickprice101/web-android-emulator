ARG EMULATOR_IMAGE=us-docker.pkg.dev/android-emulator-268719/images/34-google-x64-no-metrics:34.1.19
FROM ${EMULATOR_IMAGE}
ARG EMULATOR_IMAGE

ARG EMULATOR_SYSTEM_IMAGE=system-images;android-34;google_apis;x86_64
ARG EMULATOR_PLATFORM=platforms;android-34

RUN set -eux; \
  ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-/android/sdk}"; \
  export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT}}"; \
  export ANDROID_SDK_ROOT; \
  ensure_packages() { \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"; \
    rm -rf /var/lib/apt/lists/*; \
  }; \
  SDKMANAGER_BIN="$(command -v sdkmanager || true)"; \
  AVDMANAGER_BIN="$(command -v avdmanager || true)"; \
  if [ -z "${SDKMANAGER_BIN}" ] || [ -z "${AVDMANAGER_BIN}" ]; then \
    ensure_packages ca-certificates curl unzip; \
    mkdir -p "${ANDROID_SDK_ROOT}/cmdline-tools"; \
    TMP_ZIP="$(mktemp)"; \
    TMP_DIR="$(mktemp -d)"; \
    curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip -o "${TMP_ZIP}"; \
    unzip -q "${TMP_ZIP}" -d "${TMP_DIR}"; \
    mkdir -p "${ANDROID_SDK_ROOT}/cmdline-tools/latest"; \
    rm -rf "${ANDROID_SDK_ROOT}/cmdline-tools/latest/"*; \
    mv "${TMP_DIR}/cmdline-tools/"* "${ANDROID_SDK_ROOT}/cmdline-tools/latest/"; \
    rm -rf "${TMP_ZIP}" "${TMP_DIR}"; \
    export PATH="${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin:${PATH}"; \
    SDKMANAGER_BIN="${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/sdkmanager"; \
    AVDMANAGER_BIN="${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/avdmanager"; \
  fi; \
  if ! command -v java >/dev/null 2>&1; then \
    ensure_packages openjdk-17-jre-headless; \
  fi; \
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
  mkdir -p /root/.android; \
  touch /root/.android/repositories.cfg; \
  yes | "${SDKMANAGER_BIN}" --licenses >/dev/null; \
  "${SDKMANAGER_BIN}" --channel=0 "${EMULATOR_SYSTEM_IMAGE}" "${EMULATOR_PLATFORM}"; \
  touch /root/.android/androidtool.cfg; \
  printf '%s\n' 'android.settings.auto.update.check=false' >> /root/.android/androidtool.cfg; \
  echo "no" | "${AVDMANAGER_BIN}" create avd --force --name Pixel2 --package "${EMULATOR_SYSTEM_IMAGE}" --device "pixel_5"; \
  _avd_config="${HOME}/.android/avd/Pixel2.avd/config.ini"; \
  if [ -f "${_avd_config}" ]; then \
    sed -i '/^hw\.gsmModem=/d' "${_avd_config}"; \
    printf '%s\n' 'hw.gsmModem=no' >> "${_avd_config}"; \
    echo "Set hw.gsmModem=no in ${_avd_config} to prevent QEMU modem socket on ::1"; \
  else \
    echo "WARNING: AVD config not found at ${_avd_config}" >&2; \
    exit 1; \
  fi

COPY start-emulator-with-turn.sh /usr/local/bin/start-emulator-with-turn.sh

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    openssl \
    jq \
    python3 \
    iptables \
    iproute2 \
    nftables \
  && rm -rf /var/lib/apt/lists/*
RUN chmod +x /usr/local/bin/start-emulator-with-turn.sh

ENTRYPOINT ["/usr/local/bin/start-emulator-with-turn.sh"]
