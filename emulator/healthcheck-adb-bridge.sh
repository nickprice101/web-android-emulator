#!/bin/sh
set -eu

ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-/android/sdk}"
ADB_BIN="${ADB_BIN:-${ANDROID_SDK_ROOT}/platform-tools/adb}"

if [ ! -x "${ADB_BIN}" ]; then
  exit 1
fi

resolve_container_ipv4() {
  if command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null | tr ' ' '\n' | awk '/^[0-9]+\./ && $1 != "127.0.0.1" { print; exit }'
    return 0
  fi

  if command -v ip >/dev/null 2>&1; then
    ip -4 -o addr show scope global 2>/dev/null | awk '{split($4, addr, "/"); if (addr[1] != "127.0.0.1") { print addr[1]; exit }}'
  fi
}

adb_target="${EMULATOR_HEALTHCHECK_ADB_TARGET:-}"
if [ -z "${adb_target}" ]; then
  container_ipv4="$(resolve_container_ipv4 || true)"
  if [ -n "${container_ipv4}" ]; then
    adb_target="${container_ipv4}:5555"
  fi
fi

"${ADB_BIN}" start-server >/dev/null 2>&1 || true

if [ -n "${adb_target}" ]; then
  case "${adb_target}" in
    *:*)
      "${ADB_BIN}" connect "${adb_target}" >/dev/null 2>&1 || true
      ;;
  esac

  bridge_state="$("${ADB_BIN}" -s "${adb_target}" get-state 2>/dev/null | tr -d '\r' || true)"
  [ "${bridge_state}" = "device" ]
  exit $?
fi

emulator_state="$("${ADB_BIN}" -e get-state 2>/dev/null | tr -d '\r' || true)"
[ "${emulator_state}" = "device" ]
