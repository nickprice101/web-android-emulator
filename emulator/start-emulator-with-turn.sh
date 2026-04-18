#!/bin/sh
set -eu

TURN_SHARED_SECRET="${TURN_KEY:-}"
EMULATOR_PARAMS_VALUE="${EMULATOR_PARAMS:-}"
TURN_KEY_TRIMMED="$(printf '%s' "${TURN_SHARED_SECRET}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
TURN_PREFLIGHT_ON_START="${TURN_PREFLIGHT_ON_START:-1}"
TURN_PREFLIGHT_TIMEOUT="${TURN_PREFLIGHT_TIMEOUT:-6}"
TURN_CFG_DIR="${TURN_CFG_DIR:-/android/sdk/turncfg}"
TURN_CFG_RUNTIME_LOG="${TURN_CFG_DIR}/turncfg.runtime.log"
TURNCFG_LOG_HEXDUMP_LINES="${TURNCFG_LOG_HEXDUMP_LINES:-20}"
TURN_CFG_DIR="${TURN_CFG_DIR:-/android/sdk/turncfg}"

log() {
  printf '%s %s\n' "[start-emulator-with-turn]" "$*" >&2
}

ensure_ipv6_loopback_host() {
  if grep -Eq '^[[:space:]]*::1[[:space:]]+.*\blocalhost\b' /etc/hosts 2>/dev/null; then
    return 0
  fi

  if [ ! -w /etc/hosts ]; then
    log "WARNING: /etc/hosts is not writable; unable to add ::1 localhost entry."
    return 0
  fi

  printf '%s\n' '::1 localhost ip6-localhost ip6-loopback' >> /etc/hosts
  log "Added missing ::1 localhost mapping to /etc/hosts for qemu modem socket resolution."
}

ipv6_literal_resolution_works() {
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY' >/dev/null 2>&1
import socket
import sys

try:
    flags = getattr(socket, "AI_ADDRCONFIG", 0)
    socket.getaddrinfo("::1", 0, socket.AF_INET6, socket.SOCK_STREAM, 0, flags)
except OSError:
    sys.exit(1)

sys.exit(0)
PY
    return $?
  fi

  if command -v getent >/dev/null 2>&1; then
    getent ahostsv6 ::1 >/dev/null 2>&1
    return $?
  fi

  return 1
}

ensure_ipv6_addrconfig_interface() {
  if ipv6_literal_resolution_works; then
    log "Verified IPv6 literal ::1 resolves for qemu modem sockets."
    return 0
  fi

  if ! command -v ip >/dev/null 2>&1; then
    log "WARNING: ip command unavailable; cannot provision an IPv6 addrconfig helper interface."
    return 1
  fi

  if ! ip link show dev dummy0 >/dev/null 2>&1; then
    ip link add dummy0 type dummy >/dev/null 2>&1 || true
  fi
  if ip link show dev dummy0 >/dev/null 2>&1; then
    ip link set dummy0 up >/dev/null 2>&1 || true
    if ! ip -6 addr show dev dummy0 2>/dev/null | grep -q 'fd00::1/128'; then
      ip -6 addr add fd00::1/128 dev dummy0 >/dev/null 2>&1 || true
    fi
  fi

  if ipv6_literal_resolution_works; then
    log "Provisioned dummy IPv6 interface to satisfy AI_ADDRCONFIG for ::1 modem socket resolution."
    return 0
  fi

  log "WARNING: IPv6 literal ::1 still does not resolve after provisioning dummy IPv6 interface; qemu modem socket may still fail."
  return 1
}

ensure_ipv6_loopback_interface() {
  # qemu's modem chardev binds to ::1. Some container hosts boot with IPv6
  # disabled in the namespace, which makes getaddrinfo(::1) fail with
  # "Name or service not known". Re-enable IPv6 and restore ::1 on loopback.
  if command -v sysctl >/dev/null 2>&1; then
    sysctl -w net.ipv6.conf.all.disable_ipv6=0 >/dev/null 2>&1 || true
    sysctl -w net.ipv6.conf.default.disable_ipv6=0 >/dev/null 2>&1 || true
    sysctl -w net.ipv6.conf.lo.disable_ipv6=0 >/dev/null 2>&1 || true
  fi

  if ! command -v ip >/dev/null 2>&1; then
    log "WARNING: ip command unavailable; cannot ensure ::1 exists on loopback."
    return 0
  fi

  ip link set lo up >/dev/null 2>&1 || true
  if ! ip -6 addr show dev lo 2>/dev/null | grep -q '::1/128'; then
    ip -6 addr add ::1/128 dev lo >/dev/null 2>&1 || true
  fi

  if ip -6 addr show dev lo 2>/dev/null | grep -q '::1/128'; then
    log "Verified IPv6 loopback (::1) is present on lo."
  else
    log "WARNING: unable to provision ::1 on loopback; qemu modem socket may still fail."
  fi

  ensure_ipv6_addrconfig_interface || true
}

append_param_if_missing() {
  flag="$1"
  case " ${EMULATOR_PARAMS_VALUE} " in
    *" ${flag} "*) ;;
    *)
      if [ -n "${EMULATOR_PARAMS_VALUE}" ]; then
        EMULATOR_PARAMS_VALUE="${EMULATOR_PARAMS_VALUE} ${flag}"
      else
        EMULATOR_PARAMS_VALUE="${flag}"
      fi
      ;;
  esac
}

# Keep emulator rendering stable for native WebRTC production in headless
# container deployments. These flags are additive and can still be overridden
# by supplying explicit values in EMULATOR_PARAMS.
append_param_if_missing "-gpu swiftshader_indirect"
append_param_if_missing "-no-boot-anim"
append_param_if_missing "-camera-back none"
append_param_if_missing "-camera-front none"
append_param_if_missing "-no-snapshot-save"
# Disable SIM card emulation. Note: this does NOT prevent QEMU from creating
# the modem chardev socket (which binds to ::1 and fails when the host has
# IPv6 disabled). The direct-launch fix is an explicit -radio override, while
# hw.gsmModem=no remains as a compatibility guard in the AVD config.ini.
append_param_if_missing "-no-sim"
# PulseAudio is often unavailable or misconfigured in headless container
# environments. When the emulator cannot connect to the PulseAudio server it
# logs "Could not init 'pa' audio driver" and may stall during audio
# subsystem initialization, delaying port binding. Disable audio by default
# since it is not needed for ADB/WebRTC emulator use.
append_param_if_missing "-no-audio"
export EMULATOR_PARAMS="${EMULATOR_PARAMS_VALUE}"

export ANDROID_USER_HOME="${ANDROID_USER_HOME:-${HOME}/.android}"
export ANDROID_EMULATOR_HOME="${ANDROID_EMULATOR_HOME:-${ANDROID_USER_HOME}}"
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-${ANDROID_EMULATOR_HOME}/avd}"
export ANDROID_SDK_HOME="${ANDROID_SDK_HOME:-${HOME}}"
ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-/android/sdk}"
export PATH="${ANDROID_SDK_ROOT}/platform-tools:${ANDROID_SDK_ROOT}/emulator:${PATH}"
EMULATOR_LAUNCH_MODE="${EMULATOR_LAUNCH_MODE:-direct}"
EMULATOR_RADIO_DEVICE="${EMULATOR_RADIO_DEVICE:-null}"
mkdir -p "${ANDROID_USER_HOME}" "${ANDROID_AVD_HOME}"

ensure_pixel2_avd_aliases() {
  _sdk="${ANDROID_SDK_ROOT:-/android/sdk}"
  _canonical_avd_dir="${ANDROID_AVD_HOME}/Pixel2.avd"
  _canonical_avd_ini="${ANDROID_AVD_HOME}/Pixel2.ini"

  if [ ! -f "${_canonical_avd_dir}/config.ini" ]; then
    for _candidate_avd_dir in \
        "${HOME}/.android/avd/Pixel2.avd" \
        /Pixel2.avd \
        "${_sdk}/avd/Pixel2.avd"; do
      if [ -f "${_candidate_avd_dir}/config.ini" ]; then
        if [ "${_candidate_avd_dir}" != "${_canonical_avd_dir}" ]; then
          rm -rf "${_canonical_avd_dir}"
          cp -R "${_candidate_avd_dir}" "${_canonical_avd_dir}"
          log "Copied Pixel2 AVD into canonical home: ${_candidate_avd_dir} -> ${_canonical_avd_dir}"
        fi
        break
      fi
    done
  fi

  if [ ! -f "${_canonical_avd_dir}/config.ini" ]; then
    log "ERROR: canonical Pixel2 AVD config is missing at ${_canonical_avd_dir}/config.ini"
    exit 1
  fi

  cat > "${_canonical_avd_ini}" <<EOF
avd.ini.encoding=UTF-8
path=${_canonical_avd_dir}
path.rel=Pixel2.avd
EOF

  for _compat_avd_dir in /Pixel2.avd "${_sdk}/avd/Pixel2.avd"; do
    if [ "${_compat_avd_dir}" = "${_canonical_avd_dir}" ]; then
      continue
    fi
    mkdir -p "$(dirname "${_compat_avd_dir}")"
    rm -rf "${_compat_avd_dir}"
    ln -s "${_canonical_avd_dir}" "${_compat_avd_dir}"
  done

  for _compat_ini in /Pixel2.ini "${_sdk}/avd/Pixel2.ini"; do
    if [ "${_compat_ini}" = "${_canonical_avd_ini}" ]; then
      continue
    fi
    mkdir -p "$(dirname "${_compat_ini}")"
    rm -f "${_compat_ini}"
    ln -s "${_canonical_avd_ini}" "${_compat_ini}"
  done

  log "Canonical Pixel2 AVD home: ${_canonical_avd_dir}"
  log "Pixel2 AVD metadata search path: ANDROID_AVD_HOME=${ANDROID_AVD_HOME}, ANDROID_EMULATOR_HOME=${ANDROID_EMULATOR_HOME}, ANDROID_SDK_HOME=${ANDROID_SDK_HOME}"
}

ensure_ipv6_loopback_host
ensure_ipv6_loopback_interface
ensure_pixel2_avd_aliases

# Log the emulator configuration so that API level is immediately visible in
# container logs and cannot be confused with an old running container.
_emulator_bin="${ANDROID_SDK_ROOT}/emulator/emulator"
_emulator_version="unknown"
if [ -x "${_emulator_bin}" ]; then
  _emulator_version="$(${_emulator_bin} -version 2>&1 | head -1 || true)"
fi
DIRECT_EMULATOR_VERSION="${_emulator_version}"
_system_image_props=""
for _props_path in \
    "${ANDROID_SDK_ROOT}/system-images/android-34/google_apis/x86_64/source.properties" \
    "${ANDROID_SDK_ROOT}/system-images/android-34/google_apis/x86_64/build.prop"; do
  if [ -f "${_props_path}" ]; then
    _system_image_props="${_props_path}"
    break
  fi
done
log "emulator API configuration:"
log "  EMULATOR_IMAGE (build arg) : ${EMULATOR_IMAGE:-not set}"
log "  EMULATOR_SYSTEM_IMAGE      : ${EMULATOR_SYSTEM_IMAGE:-not set}"
log "  EMULATOR_PLATFORM          : ${EMULATOR_PLATFORM:-not set}"
log "  emulator binary version    : ${_emulator_version}"
if [ -n "${_system_image_props}" ]; then
  log "  system image props (${_system_image_props}):"
  while IFS= read -r _prop_line; do
    case "${_prop_line}" in
      '#'*|'') continue ;;
      *) log "    ${_prop_line}" ;;
    esac
  done < "${_system_image_props}"
else
  log "  system image props: not found under ${ANDROID_SDK_ROOT}/system-images/android-34"
fi
unset _emulator_bin _emulator_version _system_image_props _props_path _prop_line

# Apply critical AVD config.ini patches before the emulator is launched.
#
# (a) hw.gsmModem=no  — prevents QEMU from creating the modem chardev socket
#     bound to ::1 (IPv6 loopback), which causes a fatal "address resolution
#     failed" crash on hosts where IPv6 is disabled (e.g. Unraid).  The
#     -no-sim flag passed to the emulator binary does NOT suppress this chardev;
#     only the AVD config.ini key prevents it.
#
# (b) image.sysdir.1  — ensures the AVD uses the API 34 system image rather
#     than any pre-existing API 30 image the base image may have bundled at a
#     non-standard path (e.g. /Pixel2.avd/).  The build-time avdmanager patch
#     targets $HOME/.android/avd/Pixel2.avd/config.ini, but some base images
#     also maintain a second copy at /Pixel2.avd/config.ini that is the
#     authoritative file read by launch-emulator.sh at runtime.  Patching all
#     discovered config files here is the safe fallback.
_patch_single_avd_config() {
  _cfg="$1"
  _sdk="${ANDROID_SDK_ROOT:-/android/sdk}"
  _api34_sysdir="system-images/android-34/google_apis/x86_64/"
  sed -i '/^hw\.gsmModem=/d' "${_cfg}" 2>/dev/null || true
  printf 'hw.gsmModem=%s\n' 'no' >> "${_cfg}"
  if [ -d "${_sdk}/${_api34_sysdir}" ]; then
    sed -i '/^image\.sysdir\.1=/d' "${_cfg}" 2>/dev/null || true
    printf 'image.sysdir.1=%s\n' "${_api34_sysdir}" >> "${_cfg}"
    log "  [avd-patch] ${_cfg}: set hw.gsmModem=no, image.sysdir.1=${_api34_sysdir}"
  else
    log "  [avd-patch] ${_cfg}: set hw.gsmModem=no (API 34 sysdir not found at ${_sdk}/${_api34_sysdir}, sysdir unchanged)"
  fi
}

log "Patching AVD config.ini files (hw.gsmModem=no + API 34 system image):"
_avd_patched=0
for _cfg_candidate in \
    "${ANDROID_AVD_HOME}/Pixel2.avd/config.ini" \
    "${HOME}/.android/avd/Pixel2.avd/config.ini" \
    /Pixel2.avd/config.ini \
    "${ANDROID_SDK_ROOT:-/android/sdk}/avd/Pixel2.avd/config.ini"; do
  if [ -f "${_cfg_candidate}" ]; then
    _patch_single_avd_config "${_cfg_candidate}"
    _avd_patched=$((_avd_patched + 1))
  fi
done
if [ "${_avd_patched}" -eq 0 ]; then
  log "WARNING: No Pixel2 AVD config.ini found; hw.gsmModem and sysdir patches were NOT applied"
fi
unset _avd_patched _cfg_candidate

is_placeholder_turn_secret() {
  case "$1" in
    PLACEHOLDER*|placeholder*|REPLACE_ME*|replace_me*|CHANGEME|changeme)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

run_turn_preflight() {
  host="$1"
  port="$2"
  scheme="$3"
  timeout_s="$4"

  echo "[turn-preflight] host=${host} port=${port} scheme=${scheme}"

  if command -v getent >/dev/null 2>&1; then
    resolved="$(getent hosts "${host}" 2>/dev/null | awk 'NR==1 {print $1}')"
    if [ -n "${resolved:-}" ]; then
      echo "[turn-preflight] dns: ok (${resolved})"
    else
      echo "[turn-preflight] dns: failed (getent returned no records)"
    fi
  else
    echo "[turn-preflight] dns: skipped (getent not installed)"
  fi

  if [ "${scheme}" = "turns" ]; then
    if timeout "${timeout_s}" openssl s_client -connect "${host}:${port}" -servername "${host}" -brief </dev/null >/tmp/turn-preflight.log 2>&1; then
      echo "[turn-preflight] tls: ok"
    else
      echo "[turn-preflight] tls: failed"
      sed 's/^/[turn-preflight] /' /tmp/turn-preflight.log || true
    fi
  else
    if command -v nc >/dev/null 2>&1 && timeout "${timeout_s}" nc -z -v "${host}" "${port}" >/tmp/turn-preflight.log 2>&1; then
      echo "[turn-preflight] tcp: ok"
    else
      echo "[turn-preflight] tcp: failed (install netcat or use TURN_SCHEME=turns for TLS probe)"
      [ -f /tmp/turn-preflight.log ] && sed 's/^/[turn-preflight] /' /tmp/turn-preflight.log || true
    fi
  fi
}

if [ -n "${TURN_KEY_TRIMMED}" ] && ! is_placeholder_turn_secret "${TURN_KEY_TRIMMED}"; then
  : "${TURN_HOST:?TURN_HOST must be set when TURN_KEY is configured}"

  TURN_PORT="${TURN_PORT:-443}"
  TURN_PROTOCOL="${TURN_PROTOCOL:-tcp}"
  TURN_SCHEME="${TURN_SCHEME:-turns}"
  TURN_INTERNAL_HOST="${TURN_INTERNAL_HOST:-}"
  TURN_INTERNAL_PORT="${TURN_INTERNAL_PORT:-${TURN_PORT}}"
  TURN_INTERNAL_SCHEME="${TURN_INTERNAL_SCHEME:-${TURN_SCHEME}}"
  TURN_TTL="${TURN_TTL:-2592000}"
  TURN_USERNAME_SUFFIX="${TURN_USERNAME_SUFFIX:-emuuser}"
  # Newer emulator builds can reject the single-string urls form and report
  # "TurnCFG: Produces no result" even when JSON syntax is valid. Default to
  # array form for compatibility, while still allowing override.
  TURNCFG_URLS_FORMAT="${TURNCFG_URLS_FORMAT:-array}"

  now="$(date +%s)"
  expiry="$((now + TURN_TTL))"
  username="${expiry}:${TURN_USERNAME_SUFFIX}"
  credential="$(printf '%s' "${username}" | openssl dgst -binary -sha1 -hmac "${TURN_SHARED_SECRET}" | openssl base64 -A)"

  public_turn_url="${TURN_SCHEME}:${TURN_HOST}:${TURN_PORT}?transport=${TURN_PROTOCOL}"
  emulator_turn_host="${TURN_INTERNAL_HOST:-${TURN_HOST}}"
  emulator_turn_port="${TURN_INTERNAL_PORT:-${TURN_PORT}}"
  emulator_turn_scheme="${TURN_INTERNAL_SCHEME:-${TURN_SCHEME}}"
  turn_url="${emulator_turn_scheme}:${emulator_turn_host}:${emulator_turn_port}?transport=${TURN_PROTOCOL}"
  if [ "${turn_url}" = "${public_turn_url}" ]; then
    log "TURN key detected; preparing -turncfg payload for ${turn_url}"
  else
    log "TURN key detected; preparing emulator-local -turncfg payload for ${turn_url} while browsers keep using ${public_turn_url}"
  fi
  if [ "${TURN_PREFLIGHT_ON_START}" = "1" ]; then
    run_turn_preflight "${emulator_turn_host}" "${emulator_turn_port}" "${emulator_turn_scheme}" "${TURN_PREFLIGHT_TIMEOUT}" || true
  fi
  case "${TURNCFG_URLS_FORMAT}" in
    string|array) ;;
    *)
      log "Unsupported TURNCFG_URLS_FORMAT='${TURNCFG_URLS_FORMAT}', defaulting to 'array'"
      TURNCFG_URLS_FORMAT="array"
      ;;
  esac

  # -turncfg only guarantees support for JSON payloads that include an
  # "iceServers" array. Keep the payload minimal for widest emulator version
  # compatibility and avoid extra provider-specific fields that some images
  # can reject as an invalid turn configuration.
  if [ "${TURNCFG_URLS_FORMAT}" = "array" ]; then
    turn_payload="$(printf '{"iceServers":[{"urls":["%s"],"username":"%s","credential":"%s"}]}' \
      "${turn_url}" "${username}" "${credential}")"
  else
    turn_payload="$(printf '{"iceServers":[{"urls":"%s","username":"%s","credential":"%s"}]}' \
      "${turn_url}" "${username}" "${credential}")"
  fi
  log "turncfg urls format mode: ${TURNCFG_URLS_FORMAT}"
  # launch-emulator.sh passes TURN to `-turncfg`, and the emulator expects that
  # value to be a command that prints JSON (not raw JSON itself). Passing a
  # quoted printf expression is brittle because intermediate shells can strip
  # quoting and yield invalid JSON tokens. Write a dedicated executable script
  # and pass its path as a single command token.
  turn_cfg_script="${TURN_CFG_DIR}/turncfg.sh"
  turn_cfg_payload="${TURN_CFG_DIR}/turncfg.generated.json"
  mkdir -p "${TURN_CFG_DIR}"
  chmod 755 "${TURN_CFG_DIR}"
cat > "${turn_cfg_script}" <<EOF
#!/bin/sh
if [ "\${TURNCFG_DEBUG:-0}" = "1" ]; then
  turncfg_now="\$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  {
    echo "[turncfg] invoked: \${turncfg_now}"
    echo "[turncfg] script=${turn_cfg_script}"
    echo "[turncfg] urls_format=${TURNCFG_URLS_FORMAT}"
    echo "[turncfg] payload_file=${turn_cfg_payload}"
  } >> "${TURN_CFG_RUNTIME_LOG}"
fi
printf '%s\n' '${turn_payload}'
EOF
  # The emulator process may run as a non-root user. Keep the turncfg helper
  # executable for all users so -turncfg can invoke it reliably.
  chmod 755 "${turn_cfg_script}"
  printf '%s\n' "${turn_payload}" > "${turn_cfg_payload}"
  chmod 644 "${turn_cfg_payload}"
  log "Wrote TURN config generator to ${turn_cfg_script}"
  log "Saved generated TURN payload to ${turn_cfg_payload}"
  TURNCFG_DEBUG=0 "${turn_cfg_script}" >/tmp/turncfg.debug0.out 2>/tmp/turncfg.debug0.stderr || true
  if [ ! -s /tmp/turncfg.debug0.out ]; then
    log "ERROR: TURNCFG_DEBUG=0 ${turn_cfg_script} produced empty output"
    [ -s /tmp/turncfg.debug0.stderr ] && sed 's/^/[start-emulator-with-turn] turncfg-debug0-stderr /' /tmp/turncfg.debug0.stderr >&2 || true
    exit 1
  fi
  if command -v hexdump >/dev/null 2>&1; then
    log "turncfg hexdump preview command: TURNCFG_DEBUG=0 ${turn_cfg_script} | hexdump -C | head -n ${TURNCFG_LOG_HEXDUMP_LINES}"
    hexdump -C /tmp/turncfg.debug0.out | head -n "${TURNCFG_LOG_HEXDUMP_LINES}" | sed 's/^/[start-emulator-with-turn] turncfg-hexdump /' >&2 || true
    [ -s /tmp/turncfg.debug0.stderr ] && sed 's/^/[start-emulator-with-turn] turncfg-hexdump-stderr /' /tmp/turncfg.debug0.stderr >&2 || true
  elif command -v od >/dev/null 2>&1; then
    log "turncfg hexdump fallback command: TURNCFG_DEBUG=0 ${turn_cfg_script} | od -An -tx1 -v | head -n ${TURNCFG_LOG_HEXDUMP_LINES}"
    od -An -tx1 -v /tmp/turncfg.debug0.out | head -n "${TURNCFG_LOG_HEXDUMP_LINES}" | sed 's/^/[start-emulator-with-turn] turncfg-hexdump /' >&2 || true
    [ -s /tmp/turncfg.debug0.stderr ] && sed 's/^/[start-emulator-with-turn] turncfg-hexdump-stderr /' /tmp/turncfg.debug0.stderr >&2 || true
  else
    log "turncfg hexdump preview skipped (hexdump/od not installed)"
  fi
  if ! turn_cfg_output="$("${turn_cfg_script}" 2>/tmp/turncfg.stderr)"; then
    log "ERROR: ${turn_cfg_script} failed to execute"
    [ -s /tmp/turncfg.stderr ] && sed 's/^/[start-emulator-with-turn] /' /tmp/turncfg.stderr || true
    exit 1
  fi
  if command -v jq >/dev/null 2>&1; then
    log "turncfg jq preview command: TURNCFG_DEBUG=0 ${turn_cfg_script} | jq -c ."
    if ! jq -c . /tmp/turncfg.debug0.out 2>/tmp/turncfg.jq.parse.stderr | sed 's/^/[start-emulator-with-turn] turncfg-jq /' >&2; then
      log "ERROR: turncfg jq preview failed to parse TURNCFG_DEBUG=0 output"
      [ -s /tmp/turncfg.jq.parse.stderr ] && sed 's/^/[start-emulator-with-turn] turncfg-jq-parse /' /tmp/turncfg.jq.parse.stderr >&2 || true
      exit 1
    fi
    [ -s /tmp/turncfg.debug0.stderr ] && sed 's/^/[start-emulator-with-turn] turncfg-jq-stderr /' /tmp/turncfg.debug0.stderr >&2 || true
  elif command -v python3 >/dev/null 2>&1; then
    log "turncfg json preview command: TURNCFG_DEBUG=0 ${turn_cfg_script} | python3 -m json.tool"
    if ! python3 -m json.tool /tmp/turncfg.debug0.out 2>/tmp/turncfg.jq.parse.stderr | sed 's/^/[start-emulator-with-turn] turncfg-json /' >&2; then
      log "ERROR: turncfg json preview failed to parse TURNCFG_DEBUG=0 output"
      [ -s /tmp/turncfg.jq.parse.stderr ] && sed 's/^/[start-emulator-with-turn] turncfg-json-parse /' /tmp/turncfg.jq.parse.stderr >&2 || true
      exit 1
    fi
    [ -s /tmp/turncfg.debug0.stderr ] && sed 's/^/[start-emulator-with-turn] turncfg-json-stderr /' /tmp/turncfg.debug0.stderr >&2 || true
  else
    log "turncfg jq/json preview skipped (jq/python3 not installed)"
  fi
  if [ -z "${turn_cfg_output}" ]; then
    log "ERROR: ${turn_cfg_script} returned empty output"
    [ -s /tmp/turncfg.stderr ] && sed 's/^/[start-emulator-with-turn] /' /tmp/turncfg.stderr || true
    exit 1
  fi
  if command -v jq >/dev/null 2>&1; then
    if ! printf '%s' "${turn_cfg_output}" | jq -e '.iceServers | type == "array" and length > 0' >/dev/null 2>&1; then
      log "ERROR: turncfg output is not a valid iceServers payload: ${turn_cfg_output}"
      [ -s /tmp/turncfg.stderr ] && sed 's/^/[start-emulator-with-turn] /' /tmp/turncfg.stderr || true
      exit 1
    fi
  elif command -v python3 >/dev/null 2>&1; then
    if ! TURN_CFG_OUTPUT="${turn_cfg_output}" python3 - <<'PY'
import json
import os
import sys

try:
    payload = json.loads(os.environ["TURN_CFG_OUTPUT"])
except Exception:
    sys.exit(1)

ice_servers = payload.get("iceServers")
if not isinstance(ice_servers, list) or not ice_servers:
    sys.exit(1)
PY
    then
      log "ERROR: turncfg output is not a valid iceServers payload: ${turn_cfg_output}"
      [ -s /tmp/turncfg.stderr ] && sed 's/^/[start-emulator-with-turn] /' /tmp/turncfg.stderr || true
      exit 1
    fi
  fi
  log "turncfg preview (${TURNCFG_URLS_FORMAT}): ${turn_cfg_output}"
  [ -s /tmp/turncfg.stderr ] && log "turncfg stderr preview: $(cat /tmp/turncfg.stderr)"
  export TURN
  # Keep the emulator-invoked turncfg command deterministic and fast: legacy
  # emulator builds enforce a 1000ms timeout for -turncfg command execution.
  # Some emulator builds can fail to collect stdout from shell-script helpers
  # even when they succeed under preflight checks. Use /bin/cat on a static
  # payload file for the runtime -turncfg command to avoid interpreter/env
  # differences between startup and emulator child processes.
  export TURNCFG_DEBUG="${TURNCFG_DEBUG:-0}"
  TURN="/bin/cat ${turn_cfg_payload}"
  log "turncfg runtime command: ${TURN}"
  # The emulator runs -turncfg in a child process. Mirror that child's
  # diagnostics back into container logs so failures are visible via docker logs.
  touch "${TURN_CFG_RUNTIME_LOG}"
  (
    tail -n +1 -F "${TURN_CFG_RUNTIME_LOG}" 2>/dev/null | sed 's/^/[turncfg-runtime] /' >&2
  ) &
else
  log "TURN_KEY not set (or placeholder); skipping -turncfg setup"
fi

DIRECT_EMULATOR_BIN="${ANDROID_SDK_ROOT}/emulator/emulator"
resolve_adb_bin() {
  if [ -n "${ADB_BIN:-}" ] && [ -x "${ADB_BIN}" ]; then
    printf '%s\n' "${ADB_BIN}"
    return 0
  fi

  if command -v adb >/dev/null 2>&1; then
    command -v adb
    return 0
  fi

  for _adb_candidate in \
      "${ANDROID_SDK_ROOT}/platform-tools/adb" \
      /android/sdk/platform-tools/adb \
      /opt/android-sdk/platform-tools/adb; do
    if [ -x "${_adb_candidate}" ]; then
      printf '%s\n' "${_adb_candidate}"
      return 0
    fi
  done

  return 1
}

prepare_direct_emulator_logs() {
  _runtime_dir="${EMULATOR_RUNTIME_DIR:-/tmp/android-unknown}"
  _kernel_log="${_runtime_dir}/kernel.log"
  _logcat_log="${_runtime_dir}/logcat.log"

  mkdir -p "${_runtime_dir}"
  : > "${_kernel_log}"
  : > "${_logcat_log}"

  (
    tail -n +1 -F "${_kernel_log}" 2>/dev/null | sed 's/^/[kernel] /' >&2
  ) &
  (
    tail -n +1 -F "${_logcat_log}" 2>/dev/null | sed 's/^/[logcat] /' >&2
  ) &
}

ensure_adb_server() {
  _adb_bin="$(resolve_adb_bin || true)"
  if [ -z "${_adb_bin}" ]; then
    log "ERROR: adb binary unavailable for direct launch. Install Android SDK Platform-Tools or set ADB_BIN."
    exit 1
  fi

  if "${_adb_bin}" start-server >/tmp/adb-start.log 2>&1; then
    log "ADB server is running on port 5037 for direct emulator launch (${_adb_bin})."
  else
    log "ERROR: adb start-server failed before direct launch (${_adb_bin})."
    sed 's/^/[start-emulator-with-turn] adb-start /' /tmp/adb-start.log >&2 || true
    exit 1
  fi
}

supports_direct_radio_override() {
  _emulator_version_for_launch="${DIRECT_EMULATOR_VERSION:-unknown}"
  case "${EMULATOR_USE_RADIO_OVERRIDE:-auto}" in
    1|true|TRUE|yes|YES)
      return 0
      ;;
    0|false|FALSE|no|NO)
      return 1
      ;;
    auto|'')
      case "${_emulator_version_for_launch}" in
        "Android emulator version 30."*|"Android emulator version 29."*|"Android emulator version 28."*)
          return 1
          ;;
      esac
      if [ -x "${DIRECT_EMULATOR_BIN}" ] && "${DIRECT_EMULATOR_BIN}" -help-all 2>/dev/null | grep -Eq '(^|[[:space:]])-radio([[:space:]]|$)'; then
        return 0
      fi
      return 1
      ;;
    *)
      log "Unsupported EMULATOR_USE_RADIO_OVERRIDE='${EMULATOR_USE_RADIO_OVERRIDE}'; expected auto/true/false."
      return 1
      ;;
  esac
}

launch_direct_emulator() {
  _ports="${EMULATOR_PORTS:-5554,5555}"
  _grpc_port="${EMULATOR_GRPC_PORT:-8554}"
  _runtime_dir="${EMULATOR_RUNTIME_DIR:-/tmp/android-unknown}"
  _kernel_log="${_runtime_dir}/kernel.log"
  _logcat_log="${_runtime_dir}/logcat.log"
  _qemu_append="${EMULATOR_QEMU_APPEND:-panic=1}"
  _radio_override_applied=0

  if [ ! -x "${DIRECT_EMULATOR_BIN}" ]; then
    echo "Direct emulator binary is not executable: ${DIRECT_EMULATOR_BIN}" >&2
    exit 1
  fi

  ensure_adb_server
  prepare_direct_emulator_logs

  set -- \
    "${DIRECT_EMULATOR_BIN}" \
    -avd Pixel2 \
    -ports "${_ports}" \
    -grpc "${_grpc_port}" \
    -no-window \
    -skip-adb-auth \
    -shell-serial "file:${_kernel_log}" \
    -logcat-output "${_logcat_log}" \
    -feature AllowSnapshotMigration

  if [ -n "${EMULATOR_RADIO_DEVICE}" ] && supports_direct_radio_override; then
    set -- "$@" -radio "${EMULATOR_RADIO_DEVICE}"
    _radio_override_applied=1
  fi

  if [ -n "${TURN:-}" ]; then
    set -- "$@" -turncfg "${TURN}"
  fi

  if [ -n "${EMULATOR_PARAMS_VALUE}" ]; then
    # EMULATOR_PARAMS is a user-controlled shell-style flag string.
    # Split it once here so direct mode preserves current compose behavior.
    eval "set -- \"\$@\" ${EMULATOR_PARAMS_VALUE}"
  fi

  if [ -n "${_qemu_append}" ]; then
    set -- "$@" -qemu -append "${_qemu_append}"
  fi

  log "Using direct emulator mode; legacy launcher bypassed."
  log "Using direct emulator launch: ${DIRECT_EMULATOR_BIN}"
  log "Direct emulator ports: ${_ports} (grpc=${_grpc_port})"
  if [ "${_radio_override_applied}" -eq 1 ]; then
    log "Direct emulator radio override: ${EMULATOR_RADIO_DEVICE}"
  else
    log "Direct emulator radio override: disabled for emulator '${DIRECT_EMULATOR_VERSION:-unknown}'"
  fi
  exec "$@"
}

LAUNCHER_PATH="${EMULATOR_LAUNCHER:-}"
if [ -n "${LAUNCHER_PATH}" ] && [ ! -x "${LAUNCHER_PATH}" ]; then
  echo "Configured EMULATOR_LAUNCHER is not executable: ${LAUNCHER_PATH}" >&2
  exit 1
fi

if [ "${EMULATOR_LAUNCH_MODE}" = "legacy" ]; then
  if [ -z "${LAUNCHER_PATH}" ] && [ -x /android/sdk/launch-emulator.sh ]; then
    LAUNCHER_PATH="/android/sdk/launch-emulator.sh"
  fi

  if [ -z "${LAUNCHER_PATH}" ] && [ -n "${APP_PATH:-}" ] && [ -x "${APP_PATH}/mixins/scripts/run.sh" ]; then
    LAUNCHER_PATH="${APP_PATH}/mixins/scripts/run.sh"
  fi

  if [ -z "${LAUNCHER_PATH}" ] && [ -x /home/androidusr/docker-android/mixins/scripts/run.sh ]; then
    LAUNCHER_PATH="/home/androidusr/docker-android/mixins/scripts/run.sh"
  fi

  if [ -z "${LAUNCHER_PATH}" ]; then
    echo "No compatible emulator launcher found. Checked /android/sdk/launch-emulator.sh and docker-android run.sh." >&2
    exit 1
  fi

  log "Using emulator launcher: ${LAUNCHER_PATH}"
fi

# Copy the emulator's gRPC JWT token to the shared volume so that the
# bridge-webrtc service can authenticate its gRPC-Web requests.
# The watcher runs in the background so that exec below can still replace
# this shell process with the final emulator process.
TOKEN_WATCHER_MODE="${EMULATOR_TOKEN_WATCHER:-auto}"
if [ "${TOKEN_WATCHER_MODE}" = "auto" ]; then
  if [ "${EMULATOR_LAUNCH_MODE}" = "direct" ] || [ "${LAUNCHER_PATH}" = "/android/sdk/launch-emulator.sh" ]; then
    TOKEN_WATCHER_MODE="enabled"
  else
    TOKEN_WATCHER_MODE="disabled"
  fi
fi

if [ "${TOKEN_WATCHER_MODE}" = "enabled" ]; then
  TOKEN_DST_DIR="/run/emu-token"
  (
    mkdir -p "${TOKEN_DST_DIR}"
    while true; do
      TOKEN_SRC=$(find /root/.android/avd/ /android/avd/ /root/.config/emulator/ -name "emu-grpc-token" 2>/dev/null | head -1)
      if [ -n "${TOKEN_SRC}" ] && [ -f "${TOKEN_SRC}" ]; then
        if ! cmp -s "${TOKEN_SRC}" "${TOKEN_DST_DIR}/emu-grpc-token" 2>/dev/null; then
          cp "${TOKEN_SRC}" "${TOKEN_DST_DIR}/emu-grpc-token"
          echo "[token-watcher] copied token from ${TOKEN_SRC}"
        fi
      fi
      sleep 2
    done
  ) &
else
  log "Token watcher disabled for launcher ${LAUNCHER_PATH}"
fi

# Some emulator versions add iptables or nftables DROP rules for the ADB port
# during initialization, causing socat to receive "Connection timed out" instead
# of "Connection refused" when forwarding connections on loopback.
#
# Key lessons from previous fix attempts:
# 1. iptables commands can HANG indefinitely on some host kernels (e.g. Unraid
#    6.12 with custom modules). Every iptables call must be wrapped in timeout.
# 2. Selective rule deletion (-D) misses rules added with match extensions
#    like -m state, -m multiport, etc. Flushing the entire chain is safer.
# 3. Modern emulator builds (or the base image's launch-emulator.sh) may use
#    nftables directly rather than the legacy iptables frontend.
# 4. Both iptables (nft backend) and iptables-legacy (legacy backend) must be
#    cleared since the emulator and the kernel may use different backends.
if [ -n "${EMULATOR_ADB_PORT:-}" ]; then
  ADB_PORT="${EMULATOR_ADB_PORT}"
elif [ "${EMULATOR_LAUNCH_MODE}" = "legacy" ]; then
  ADB_PORT="5557"
else
  ADB_PORT="5555"
fi
ADB_PORT_GUARD_INTERVAL="${ADB_PORT_GUARD_INTERVAL:-1}"

_ensure_adb_accept() {
  _adb_port="${ADB_PORT:-5557}"
  _any_filter=0
  for _ipt in iptables iptables-legacy; do
    command -v "${_ipt}" >/dev/null 2>&1 || continue
    _any_filter=1
    # Set ACCEPT default policies so any rules that survive between iterations
    # cannot cause a permanent block.  Wrap every call in timeout to prevent
    # the guard from hanging if iptables blocks on a kernel lock.
    timeout 3 "${_ipt}" -P INPUT   ACCEPT 2>/dev/null || true
    timeout 3 "${_ipt}" -P OUTPUT  ACCEPT 2>/dev/null || true
    timeout 3 "${_ipt}" -P FORWARD ACCEPT 2>/dev/null || true
    # Flush entire filter chains rather than deleting specific rules.  This
    # catches DROP rules added with any match extension (state, multiport, etc.)
    # that a targeted -D command would not find.  It is safe here because:
    # (a) each container has its own network namespace — Docker's bridge rules
    #     live in the HOST namespace and are unaffected; and
    # (b) launch-emulator.sh uses socat for ADB forwarding, not iptables.
    timeout 3 "${_ipt}" -F INPUT   2>/dev/null || true
    timeout 3 "${_ipt}" -F OUTPUT  2>/dev/null || true
    timeout 3 "${_ipt}" -F FORWARD 2>/dev/null || true
    log "${_ipt}: flushed INPUT/OUTPUT/FORWARD filter chains, policies set to ACCEPT"
  done
  # Flush nftables filter-input/output chains — some emulator builds or
  # base-image scripts add DROP rules directly via nft rather than through the
  # iptables frontend.  We target only the input and output chains of the
  # standard filter tables (inet and ip) rather than flushing the entire
  # ruleset to avoid disturbing NAT or mangle rules that may be present.
  if command -v nft >/dev/null 2>&1; then
    _any_filter=1
    for _nft_table in "inet filter" "ip filter"; do
      timeout 3 nft flush chain ${_nft_table} input  2>/dev/null || true
      timeout 3 nft flush chain ${_nft_table} output 2>/dev/null || true
    done
    log "nft: flushed filter input/output chains (inet and ip)"
  fi
  if [ "${_any_filter}" -eq 0 ]; then
    log "WARNING: neither iptables nor nft found; ADB port guard inactive"
  fi
}

# Run the initial flush synchronously before exec so there is no window
# between process start and the first guard iteration.
_ensure_adb_accept

# Write the guard loop to a file and run it via setsid so it is in its own
# session and is NOT killed when the current shell process-group is replaced
# by exec.  This is the most reliable way to keep the guard alive across the
# exec chain: start-emulator-with-turn.sh -> launcher/direct mode -> emulator.
_GUARD_SCRIPT=/tmp/adb-port-guard.sh
cat > "${_GUARD_SCRIPT}" << GUARD_EOF
#!/bin/sh
ADB_PORT="${ADB_PORT}"
ADB_PORT_GUARD_INTERVAL="${ADB_PORT_GUARD_INTERVAL}"
_guard_iter=0
while true; do
  sleep "\${ADB_PORT_GUARD_INTERVAL}"
  _guard_iter=\$((_guard_iter + 1))
  for _ipt in iptables iptables-legacy; do
    command -v "\${_ipt}" >/dev/null 2>&1 || continue
    timeout 2 "\${_ipt}" -P INPUT   ACCEPT 2>/dev/null || true
    timeout 2 "\${_ipt}" -P OUTPUT  ACCEPT 2>/dev/null || true
    timeout 2 "\${_ipt}" -P FORWARD ACCEPT 2>/dev/null || true
    timeout 2 "\${_ipt}" -F INPUT   2>/dev/null || true
    timeout 2 "\${_ipt}" -F OUTPUT  2>/dev/null || true
    timeout 2 "\${_ipt}" -F FORWARD 2>/dev/null || true
  done
  if command -v nft >/dev/null 2>&1; then
    for _nft_table in "inet filter" "ip filter"; do
      timeout 2 nft flush chain \${_nft_table} input  2>/dev/null || true
      timeout 2 nft flush chain \${_nft_table} output 2>/dev/null || true
    done
  fi
  # Log a heartbeat every 60 iterations so the guard is visible in container
  # logs and failures can be diagnosed without guessing whether it is running.
  if [ \$((_guard_iter % 60)) -eq 0 ]; then
    echo "[adb-port-guard] alive: iter=\${_guard_iter} port=\${ADB_PORT} interval=\${ADB_PORT_GUARD_INTERVAL}s" >&2
  fi
done
GUARD_EOF
chmod +x "${_GUARD_SCRIPT}"
setsid "${_GUARD_SCRIPT}" &
log "ADB port guard started for port ${ADB_PORT} (interval ${ADB_PORT_GUARD_INTERVAL}s)"

if [ "${EMULATOR_LAUNCH_MODE}" = "direct" ]; then
  launch_direct_emulator
fi

exec "${LAUNCHER_PATH}" "$@"
