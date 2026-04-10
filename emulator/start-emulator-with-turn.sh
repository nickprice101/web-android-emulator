#!/bin/sh
set -eu

TURN_SHARED_SECRET="${TURN_KEY:-}"
EMULATOR_PARAMS_VALUE="${EMULATOR_PARAMS:-}"
TURN_KEY_TRIMMED="$(printf '%s' "${TURN_SHARED_SECRET}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
TURN_PREFLIGHT_ON_START="${TURN_PREFLIGHT_ON_START:-1}"
TURN_PREFLIGHT_TIMEOUT="${TURN_PREFLIGHT_TIMEOUT:-6}"
TURN_CFG_RUNTIME_LOG="/tmp/android-unknown/turncfg.runtime.log"

log() {
  printf '%s %s\n' "[start-emulator-with-turn]" "$*" >&2
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
export EMULATOR_PARAMS="${EMULATOR_PARAMS_VALUE}"

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

  now="$(date +%s)"
  expiry="$((now + TURN_TTL))"
  username="${expiry}:${TURN_USERNAME_SUFFIX}"
  credential="$(printf '%s' "${username}" | openssl dgst -binary -sha1 -hmac "${TURN_SHARED_SECRET}" | openssl base64 -A)"

  turn_url="${TURN_SCHEME}:${TURN_HOST}:${TURN_PORT}?transport=${TURN_PROTOCOL}"
  log "TURN key detected; preparing -turncfg payload for ${turn_url}"
  if [ "${TURN_PREFLIGHT_ON_START}" = "1" ]; then
    run_turn_preflight "${TURN_HOST}" "${TURN_PORT}" "${TURN_SCHEME}" "${TURN_PREFLIGHT_TIMEOUT}" || true
  fi
  # -turncfg only guarantees support for JSON payloads that include an
  # "iceServers" array. Keep the payload minimal for widest emulator version
  # compatibility and avoid extra provider-specific fields that some images
  # can reject as an invalid turn configuration.
  turn_payload="$(printf '{"iceServers":[{"urls":"%s","username":"%s","credential":"%s"}]}' \
    "${turn_url}" "${username}" "${credential}")"
  # launch-emulator.sh passes TURN to `-turncfg`, and the emulator expects that
  # value to be a command that prints JSON (not raw JSON itself). Passing a
  # quoted printf expression is brittle because intermediate shells can strip
  # quoting and yield invalid JSON tokens. Write a dedicated executable script
  # and pass its path as a single command token.
  turn_cfg_script="/tmp/android-unknown/turncfg.sh"
  mkdir -p "$(dirname "${turn_cfg_script}")"
  cat > "${turn_cfg_script}" <<EOF
#!/bin/sh
if [ "\${TURNCFG_DEBUG:-1}" = "1" ]; then
  turncfg_now="\$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ -w /proc/1/fd/1 ]; then
    printf '%s\n' "[turncfg] invoked at \${turncfg_now}; script=${turn_cfg_script}" > /proc/1/fd/1 || true
  fi
  if [ -w /proc/1/fd/2 ]; then
    printf '%s\n' "[turncfg] payload file /tmp/android-unknown/turncfg.generated.json" > /proc/1/fd/2 || true
  fi
  {
    echo "[turncfg] invoked: \${turncfg_now}"
    echo "[turncfg] script=${turn_cfg_script}"
    echo "[turncfg] payload_file=/tmp/android-unknown/turncfg.generated.json"
  } >> "${TURN_CFG_RUNTIME_LOG}"
fi
printf '%s\n' '${turn_payload}' > /tmp/android-unknown/turncfg.runtime.out.json
printf '%s\n' '${turn_payload}'
EOF
  chmod 700 "${turn_cfg_script}"
  printf '%s\n' "${turn_payload}" > /tmp/android-unknown/turncfg.generated.json
  log "Wrote TURN config generator to ${turn_cfg_script}"
  log "Saved generated TURN payload to /tmp/android-unknown/turncfg.generated.json"
  if ! turn_cfg_output="$("${turn_cfg_script}" 2>/tmp/turncfg.stderr)"; then
    log "ERROR: ${turn_cfg_script} failed to execute"
    [ -s /tmp/turncfg.stderr ] && sed 's/^/[start-emulator-with-turn] /' /tmp/turncfg.stderr || true
    exit 1
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
  log "turncfg preview: ${turn_cfg_output}"
  export TURN
  TURN="${turn_cfg_script}"
  # The emulator runs -turncfg in a child process. Mirror that child's
  # diagnostics back into container logs so failures are visible via docker logs.
  touch "${TURN_CFG_RUNTIME_LOG}"
  (
    tail -n +1 -F "${TURN_CFG_RUNTIME_LOG}" 2>/dev/null | sed 's/^/[turncfg-runtime] /' >&2
  ) &
else
  log "TURN_KEY not set (or placeholder); skipping -turncfg setup"
fi

if [ ! -x /android/sdk/launch-emulator.sh ]; then
  echo "Missing emulator launcher at /android/sdk/launch-emulator.sh" >&2
  exit 1
fi

# Copy the emulator's gRPC JWT token to the shared volume so that the
# bridge-webrtc service can authenticate its gRPC-Web requests.
# The watcher runs in the background so that exec below can still replace
# this shell process with launch-emulator.sh.
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

exec /android/sdk/launch-emulator.sh "$@"
