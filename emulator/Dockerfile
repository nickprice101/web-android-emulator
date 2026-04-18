ARG EMULATOR_IMAGE=us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:7148297
FROM ${EMULATOR_IMAGE}
ARG EMULATOR_IMAGE

ARG EMULATOR_SYSTEM_IMAGE=system-images;android-34;google_apis;x86_64
ARG EMULATOR_PLATFORM=platforms;android-34

ENV ANDROID_USER_HOME=/root/.android \
    ANDROID_EMULATOR_HOME=/root/.android \
    ANDROID_AVD_HOME=/root/.android/avd \
    ANDROID_SDK_HOME=/root \
    PATH=/android/sdk/platform-tools:/android/sdk/emulator:${PATH}

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
  mkdir -p "${ANDROID_USER_HOME}" "${ANDROID_AVD_HOME}"; \
  touch "${ANDROID_USER_HOME}/repositories.cfg"; \
  yes | "${SDKMANAGER_BIN}" --licenses >/dev/null; \
  "${SDKMANAGER_BIN}" --channel=0 "platform-tools" "${EMULATOR_SYSTEM_IMAGE}" "${EMULATOR_PLATFORM}"; \
  if [ ! -x "${ANDROID_SDK_ROOT}/platform-tools/adb" ]; then \
    echo "Expected adb at ${ANDROID_SDK_ROOT}/platform-tools/adb after installing platform-tools" >&2; \
    exit 1; \
  fi; \
  touch "${ANDROID_USER_HOME}/androidtool.cfg"; \
  printf '%s\n' 'android.settings.auto.update.check=false' >> "${ANDROID_USER_HOME}/androidtool.cfg"; \
  echo "no" | "${AVDMANAGER_BIN}" create avd --force --name Pixel2 --package "${EMULATOR_SYSTEM_IMAGE}" --device "pixel_5"; \
  _avd_dir="${ANDROID_AVD_HOME}/Pixel2.avd"; \
  _avd_ini="${ANDROID_AVD_HOME}/Pixel2.ini"; \
  _avd_config="${_avd_dir}/config.ini"; \
  if [ -f "${_avd_config}" ]; then \
    sed -i '/^hw\.gsmModem=/d' "${_avd_config}"; \
    printf '%s\n' 'hw.gsmModem=no' >> "${_avd_config}"; \
    echo "Set hw.gsmModem=no in ${_avd_config} to prevent QEMU modem socket on ::1"; \
  else \
    echo "WARNING: AVD config not found at ${_avd_config}" >&2; \
    exit 1; \
  fi; \
  if [ -f "${_avd_ini}" ]; then \
    sed -i '/^path=/d;/^path\.rel=/d' "${_avd_ini}"; \
    printf 'path=%s\n' "${_avd_dir}" >> "${_avd_ini}"; \
    printf 'path.rel=%s\n' "Pixel2.avd" >> "${_avd_ini}"; \
  fi; \
  sed -i '/^image\.sysdir\.1=/d' "${_avd_config}"; \
  printf 'image.sysdir.1=%s\n' "system-images/android-34/google_apis/x86_64/" >> "${_avd_config}"; \
  rm -rf /Pixel2.avd; \
  ln -s "${_avd_dir}" /Pixel2.avd; \
  rm -f /Pixel2.ini; \
  ln -s "${_avd_ini}" /Pixel2.ini; \
  mkdir -p "${ANDROID_SDK_ROOT}/avd"; \
  rm -rf "${ANDROID_SDK_ROOT}/avd/Pixel2.avd"; \
  ln -s "${_avd_dir}" "${ANDROID_SDK_ROOT}/avd/Pixel2.avd"; \
  rm -f "${ANDROID_SDK_ROOT}/avd/Pixel2.ini"; \
  ln -s "${_avd_ini}" "${ANDROID_SDK_ROOT}/avd/Pixel2.ini"; \
  echo "Canonicalized Pixel2 AVD metadata and compatibility links for /Pixel2.avd and ${ANDROID_SDK_ROOT}/avd/Pixel2.avd"

COPY start-emulator-with-turn.sh /usr/local/bin/start-emulator-with-turn.sh
COPY healthcheck-adb-bridge.sh /usr/local/bin/healthcheck-adb-bridge.sh

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    openssl \
    jq \
    python3 \
    iptables \
    iproute2 \
    nftables \
  && rm -rf /var/lib/apt/lists/*
RUN chmod +x /usr/local/bin/start-emulator-with-turn.sh /usr/local/bin/healthcheck-adb-bridge.sh

HEALTHCHECK --interval=30s --timeout=30s --start-period=180s --retries=10 CMD ["/usr/local/bin/healthcheck-adb-bridge.sh"]

ENTRYPOINT ["/usr/local/bin/start-emulator-with-turn.sh"]
