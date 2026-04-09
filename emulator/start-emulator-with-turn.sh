#!/bin/sh
set -eu

TURN_SHARED_SECRET="${TURN_KEY:-}"
EMULATOR_PARAMS_VALUE="${EMULATOR_PARAMS:-}"

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

if [ -n "${TURN_SHARED_SECRET:-}" ]; then
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

  turn_payload="$(printf '{"iceServers":[{"urls":["%s:%s:%s?transport=%s"],"username":"%s","credential":"%s"}]}' \
    "${TURN_SCHEME}" "${TURN_HOST}" "${TURN_PORT}" "${TURN_PROTOCOL}" "${username}" "${credential}")"
  # launch-emulator.sh passes TURN to `-turncfg`, and the emulator expects that
  # value to be an executable command that prints JSON (not raw JSON itself).
  # Use a shell-safe printf command so the generated credentials are returned.
  turn_payload_escaped="$(printf '%s' "${turn_payload}" | sed "s/'/'\"'\"'/g")"
  export TURN
  TURN="printf '%s' '${turn_payload_escaped}'"
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
