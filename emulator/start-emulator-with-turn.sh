#!/bin/sh
set -eu

if [ -n "${TURN_SECRET:-}" ]; then
  : "${TURN_HOST:?TURN_HOST must be set when TURN_SECRET is configured}"

  TURN_PORT="${TURN_PORT:-443}"
  TURN_PROTOCOL="${TURN_PROTOCOL:-tcp}"
  TURN_SCHEME="${TURN_SCHEME:-turns}"
  TURN_TTL="${TURN_TTL:-86400}"
  TURN_USERNAME_SUFFIX="${TURN_USERNAME_SUFFIX:-emuuser}"

  now="$(date +%s)"
  expiry="$((now + TURN_TTL))"
  username="${expiry}:${TURN_USERNAME_SUFFIX}"
  credential="$(printf '%s' "${username}" | openssl dgst -binary -sha1 -hmac "${TURN_SECRET}" | openssl base64 -A)"

  export TURN
  TURN="$(printf '{"iceServers":[{"urls":["%s:%s:%s?transport=%s"],"username":"%s","credential":"%s"}]}' \
    "${TURN_SCHEME}" "${TURN_HOST}" "${TURN_PORT}" "${TURN_PROTOCOL}" "${username}" "${credential}")"
fi

if [ ! -x /android/sdk/launch-emulator.sh ]; then
  echo "Missing emulator launcher at /android/sdk/launch-emulator.sh" >&2
  exit 1
fi

exec /android/sdk/launch-emulator.sh "$@"
