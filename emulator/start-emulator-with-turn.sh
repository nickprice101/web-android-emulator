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

ensure_ipv6_loopback_interface() {
  if command -v ip >/dev/null 2>&1 && ip -6 addr show dev lo 2>/dev/null | grep -q '::1/128'; then
    return 0
  fi

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
# Some container hosts disable IPv6 loopback inside network namespaces. When
# that happens, recent emulator/qemu builds can fail at startup while trying to
# bring up the modem chardev on ::1. Disable SIM/modem initialization by
# default to avoid the IPv6-only modem bind path.
append_param_if_missing "-no-sim"
export EMULATOR_PARAMS="${EMULATOR_PARAMS_VALUE}"

ensure_ipv6_loopback_host
ensure_ipv6_loopback_interface

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

  turn_url="${TURN_SCHEME}:${TURN_HOST}:${TURN_PORT}?transport=${TURN_PROTOCOL}"
  log "TURN key detected; preparing -turncfg payload for ${turn_url}"
  if [ "${TURN_PREFLIGHT_ON_START}" = "1" ]; then
    run_turn_preflight "${TURN_HOST}" "${TURN_PORT}" "${TURN_SCHEME}" "${TURN_PREFLIGHT_TIMEOUT}" || true
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

LAUNCHER_PATH="${EMULATOR_LAUNCHER:-}"
if [ -n "${LAUNCHER_PATH}" ] && [ ! -x "${LAUNCHER_PATH}" ]; then
  echo "Configured EMULATOR_LAUNCHER is not executable: ${LAUNCHER_PATH}" >&2
  exit 1
fi

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

# Copy the emulator's gRPC JWT token to the shared volume so that the
# bridge-webrtc service can authenticate its gRPC-Web requests.
# The watcher runs in the background so that exec below can still replace
# this shell process with launch-emulator.sh.
TOKEN_WATCHER_MODE="${EMULATOR_TOKEN_WATCHER:-auto}"
if [ "${TOKEN_WATCHER_MODE}" = "auto" ]; then
  if [ "${LAUNCHER_PATH}" = "/android/sdk/launch-emulator.sh" ]; then
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

exec "${LAUNCHER_PATH}" "$@"
