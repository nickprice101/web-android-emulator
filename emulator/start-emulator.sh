#!/bin/sh
set -eu

EMULATOR_PARAMS_VALUE="${EMULATOR_PARAMS:-}"

log() {
  printf '%s %s\n' "[start-emulator]" "$*" >&2
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

param_has_flag() {
  flag="$1"
  case " ${EMULATOR_PARAMS_VALUE} " in
    *" ${flag} "*) return 0 ;;
    *) return 1 ;;
  esac
}

append_param_value_if_flag_missing() {
  flag="$1"
  value="$2"
  if ! param_has_flag "${flag}"; then
    append_param_if_missing "${flag} ${value}"
  fi
}

virtual_display_enabled() {
  case "${EMULATOR_VIRTUAL_DISPLAY:-1}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    0|false|FALSE|no|NO|off|OFF|'') return 1 ;;
    *)
      log "Unsupported EMULATOR_VIRTUAL_DISPLAY='${EMULATOR_VIRTUAL_DISPLAY}'; expected true/false."
      exit 1
      ;;
  esac
}

display_number_from_name() {
  printf '%s' "$1" | sed 's/^.*://; s/\..*$//'
}

start_virtual_x_display() {
  EMULATOR_X_DISPLAY="${EMULATOR_X_DISPLAY:-:99}"
  EMULATOR_X_SCREEN="${EMULATOR_X_SCREEN:-0}"
  EMULATOR_X_SCREEN_SIZE="${EMULATOR_X_SCREEN_SIZE:-1080x1920x24}"
  _x_display_number="$(display_number_from_name "${EMULATOR_X_DISPLAY}")"
  case "${_x_display_number}" in
    ''|*[!0-9]*)
      log "Unsupported EMULATOR_X_DISPLAY='${EMULATOR_X_DISPLAY}'; expected a display such as :99."
      exit 1
      ;;
  esac
  _x_socket="/tmp/.X11-unix/X${_x_display_number}"
  _x_log="${EMULATOR_X_LOG:-/tmp/xvfb-emulator.log}"

  if ! command -v Xvfb >/dev/null 2>&1; then
    log "ERROR: Xvfb is unavailable; cannot start virtual emulator display."
    exit 1
  fi

  mkdir -p /tmp/.X11-unix
  chmod 1777 /tmp/.X11-unix 2>/dev/null || true
  rm -f "${_x_socket}" 2>/dev/null || true
  : > "${_x_log}"
  (
    tail -n +1 -F "${_x_log}" 2>/dev/null | sed 's/^/[xvfb] /' >&2
  ) &

  Xvfb "${EMULATOR_X_DISPLAY}" \
    -screen "${EMULATOR_X_SCREEN}" "${EMULATOR_X_SCREEN_SIZE}" \
    -ac \
    -listen tcp \
    >"${_x_log}" 2>&1 &
  EMULATOR_XVFB_PID="$!"
  export DISPLAY="${EMULATOR_X_DISPLAY}"

  _x_wait=0
  while [ "${_x_wait}" -lt 50 ]; do
    if [ -S "${_x_socket}" ]; then
      log "Started Xvfb display ${EMULATOR_X_DISPLAY} (${EMULATOR_X_SCREEN_SIZE}); TCP capture endpoint is port $((6000 + _x_display_number))."
      unset _x_display_number _x_socket _x_log _x_wait
      return 0
    fi
    if ! kill -0 "${EMULATOR_XVFB_PID}" 2>/dev/null; then
      log "ERROR: Xvfb exited before creating ${_x_socket}."
      exit 1
    fi
    _x_wait=$((_x_wait + 1))
    sleep 0.1
  done

  log "ERROR: timed out waiting for Xvfb display socket ${_x_socket}."
  exit 1
}

# Keep emulator rendering stable for virtual-display HTTP video capture in
# container deployments. These flags are additive and can still be overridden
# by supplying explicit values in EMULATOR_PARAMS.
EMULATOR_GPU_MODE="${EMULATOR_GPU_MODE:-swiftshader_indirect}"
case "${EMULATOR_GPU_MODE}" in
  ""|"none"|"disabled") ;;
  *) append_param_value_if_flag_missing "-gpu" "${EMULATOR_GPU_MODE}" ;;
esac
append_param_if_missing "-no-metrics"
append_param_if_missing "-no-boot-anim"
append_param_if_missing "-camera-back none"
append_param_if_missing "-camera-front none"
append_param_if_missing "-no-snapshot-save"
EMULATOR_RAM_SIZE_MB="${EMULATOR_RAM_SIZE_MB:-6144}"
case "${EMULATOR_RAM_SIZE_MB}" in
  ''|*[!0-9]*)
    log "Unsupported EMULATOR_RAM_SIZE_MB='${EMULATOR_RAM_SIZE_MB}'; expected a number of megabytes."
    exit 1
    ;;
  *)
    if [ "${EMULATOR_RAM_SIZE_MB}" -le 4096 ]; then
      log "Unsupported EMULATOR_RAM_SIZE_MB='${EMULATOR_RAM_SIZE_MB}'; expected more than 4096 MB for AI app testing."
      exit 1
    fi
    append_param_value_if_flag_missing "-memory" "${EMULATOR_RAM_SIZE_MB}"
    ;;
esac
# Disable SIM card emulation. Note: this does NOT prevent QEMU from creating
# the modem chardev socket (which binds to ::1 and fails when the host has
# IPv6 disabled). The direct-launch fix is an explicit -radio override, while
# hw.gsmModem=no remains as a compatibility guard in the AVD config.ini.
append_param_if_missing "-no-sim"
# PulseAudio is often unavailable or misconfigured in headless container
# environments. When the emulator cannot connect to the PulseAudio server it
# logs "Could not init 'pa' audio driver" and may stall during audio
# subsystem initialization, delaying port binding. Disable audio by default
# since it is not needed for ADB/HTTP emulator use.
append_param_if_missing "-no-audio"
if virtual_display_enabled && ! param_has_flag "-skin" && ! param_has_flag "-no-skin" && ! param_has_flag "-noskin"; then
  append_param_if_missing "-no-skin"
fi
EMULATOR_AVD_READ_ONLY="${EMULATOR_AVD_READ_ONLY:-1}"
case "${EMULATOR_AVD_READ_ONLY}" in
  1|true|TRUE|yes|YES)
    append_param_if_missing "-read-only"
    ;;
  0|false|FALSE|no|NO|'') ;;
  *)
    log "Unsupported EMULATOR_AVD_READ_ONLY='${EMULATOR_AVD_READ_ONLY}'; expected true/false."
    exit 1
    ;;
esac
export EMULATOR_PARAMS="${EMULATOR_PARAMS_VALUE}"

export ANDROID_USER_HOME="${ANDROID_USER_HOME:-${HOME}/.android}"
export ANDROID_EMULATOR_HOME="${ANDROID_EMULATOR_HOME:-${ANDROID_USER_HOME}}"
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-${ANDROID_EMULATOR_HOME}/avd}"
export ANDROID_SDK_HOME="${ANDROID_SDK_HOME:-${HOME}}"
ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-/android/sdk}"
export PATH="${ANDROID_SDK_ROOT}/platform-tools:${ANDROID_SDK_ROOT}/emulator:${PATH}"
EMULATOR_LAUNCH_MODE="${EMULATOR_LAUNCH_MODE:-direct}"
EMULATOR_RADIO_DEVICE="${EMULATOR_RADIO_DEVICE:-null}"
EMULATOR_USE_RADIO_OVERRIDE="${EMULATOR_USE_RADIO_OVERRIDE:-0}"
EMULATOR_SYSTEM_IMAGE="${EMULATOR_SYSTEM_IMAGE:-system-images;android-36;google_apis;x86_64}"
EMULATOR_PLATFORM="${EMULATOR_PLATFORM:-platforms;android-36}"
EMULATOR_X_CAPTURE_SIZE="${EMULATOR_X_CAPTURE_SIZE:-1080x1920}"
mkdir -p "${ANDROID_USER_HOME}" "${ANDROID_AVD_HOME}"

emulator_system_image_sysdir() {
  printf '%s/' "$(printf '%s' "${EMULATOR_SYSTEM_IMAGE}" | tr ';' '/')"
}

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

remove_stale_pixel2_avd_locks() {
  if ps -eo args 2>/dev/null | grep -Eq '[e]mulator([[:space:]].*)?[[:space:]]-avd[[:space:]]+Pixel2|[q]emu-system.*Pixel2'; then
    log "WARNING: detected a running Pixel2 emulator process; leaving AVD lock files intact."
    return 0
  fi

  _removed_locks=0
  _remove_lock_path() {
    _lock_path="$1"
    if [ -e "${_lock_path}" ]; then
      rm -rf "${_lock_path}" 2>/dev/null || true
      _removed_locks=$((_removed_locks + 1))
      log "Removed stale Pixel2 AVD lock: ${_lock_path}"
    fi
  }

  for _lock_candidate in \
      "${ANDROID_AVD_HOME}/Pixel2.ini.lock" \
      "${HOME}/.android/avd/Pixel2.ini.lock" \
      /Pixel2.ini.lock \
      "${ANDROID_SDK_ROOT:-/android/sdk}/avd/Pixel2.ini.lock"; do
    _remove_lock_path "${_lock_candidate}"
  done

  for _avd_lock_root in \
      "${ANDROID_AVD_HOME}/Pixel2.avd" \
      "${HOME}/.android/avd/Pixel2.avd" \
      /Pixel2.avd \
      "${ANDROID_SDK_ROOT:-/android/sdk}/avd/Pixel2.avd"; do
    if [ ! -d "${_avd_lock_root}" ]; then
      continue
    fi
    while IFS= read -r _lock_path; do
      [ -n "${_lock_path}" ] || continue
      _remove_lock_path "${_lock_path}"
    done <<EOF
$(find "${_avd_lock_root}" -depth -name '*.lock' -print 2>/dev/null || true)
EOF
  done

  if [ "${_removed_locks}" -eq 0 ]; then
    log "No stale Pixel2 AVD lock files found."
  fi

  unset _removed_locks _lock_candidate _avd_lock_root _lock_path
}

ensure_ipv6_loopback_host
ensure_ipv6_loopback_interface
ensure_pixel2_avd_aliases
remove_stale_pixel2_avd_locks

# Log the emulator configuration so that API level is immediately visible in
# container logs and cannot be confused with an old running container.
_emulator_bin="${ANDROID_SDK_ROOT}/emulator/emulator"
_emulator_version="unknown"
if [ -x "${_emulator_bin}" ]; then
  _emulator_version="$(${_emulator_bin} -version 2>&1 | head -1 || true)"
fi
DIRECT_EMULATOR_VERSION="${_emulator_version}"
_system_image_props=""
_system_image_sysdir="$(emulator_system_image_sysdir)"
for _props_path in \
    "${ANDROID_SDK_ROOT}/${_system_image_sysdir}source.properties" \
    "${ANDROID_SDK_ROOT}/${_system_image_sysdir}build.prop"; do
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
  log "  system image props: not found under ${ANDROID_SDK_ROOT}/${_system_image_sysdir}"
fi
unset _emulator_bin _emulator_version _system_image_props _system_image_sysdir _props_path _prop_line

# Apply critical AVD config.ini patches before the emulator is launched.
#
# (a) hw.gsmModem=no  — prevents QEMU from creating the modem chardev socket
#     bound to ::1 (IPv6 loopback), which causes a fatal "address resolution
#     failed" crash on hosts where IPv6 is disabled (e.g. Unraid).  The
#     -no-sim flag passed to the emulator binary does NOT suppress this chardev;
#     only the AVD config.ini key prevents it.
#
# (b) image.sysdir.1  — ensures the AVD uses the selected system image rather
#     than any pre-existing image the base image may have bundled at a
#     non-standard path (e.g. /Pixel2.avd/). The build-time avdmanager patch
#     targets $HOME/.android/avd/Pixel2.avd/config.ini, but some base images
#     also maintain a second copy at /Pixel2.avd/config.ini that is the
#     authoritative file read by launch-emulator.sh at runtime.  Patching all
#     discovered config files here is the safe fallback.
_patch_single_avd_config() {
  _cfg="$1"
  _sdk="${ANDROID_SDK_ROOT:-/android/sdk}"
  _image_sysdir="$(emulator_system_image_sysdir)"
  sed -i '/^hw\.gsmModem=/d' "${_cfg}" 2>/dev/null || true
  sed -i '/^hw\.ramSize=/d' "${_cfg}" 2>/dev/null || true
  printf 'hw.gsmModem=%s\n' 'no' >> "${_cfg}"
  printf 'hw.ramSize=%s\n' "${EMULATOR_RAM_SIZE_MB}" >> "${_cfg}"
  if [ -d "${_sdk}/${_image_sysdir}" ]; then
    sed -i '/^image\.sysdir\.1=/d' "${_cfg}" 2>/dev/null || true
    printf 'image.sysdir.1=%s\n' "${_image_sysdir}" >> "${_cfg}"
    log "  [avd-patch] ${_cfg}: set hw.gsmModem=no, hw.ramSize=${EMULATOR_RAM_SIZE_MB}, image.sysdir.1=${_image_sysdir}"
  else
    log "  [avd-patch] ${_cfg}: set hw.gsmModem=no, hw.ramSize=${EMULATOR_RAM_SIZE_MB} (system image sysdir not found at ${_sdk}/${_image_sysdir}, sysdir unchanged)"
  fi
}

log "Patching AVD config.ini files (hw.gsmModem=no + ${EMULATOR_RAM_SIZE_MB} MB RAM + ${EMULATOR_SYSTEM_IMAGE} system image):"
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
    sed 's/^/[start-emulator] adb-start /' /tmp/adb-start.log >&2 || true
    exit 1
  fi
}

resolve_container_ipv4() {
  if command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null | tr ' ' '\n' | awk '/^[0-9]+\./ && $1 != "127.0.0.1" { print; exit }'
    return 0
  fi

  if command -v ip >/dev/null 2>&1; then
    ip -4 -o addr show scope global 2>/dev/null | awk '{split($4, addr, "/"); if (addr[1] != "127.0.0.1") { print addr[1]; exit }}'
  fi
}

start_direct_adb_bridge_forwarder() {
  _bridge_port="${EMULATOR_ADB_BRIDGE_PORT:-5555}"
  _container_ipv4="$(resolve_container_ipv4 || true)"
  _forwarder_log="${EMULATOR_ADB_BRIDGE_LOG:-/tmp/adb-bridge-forwarder.log}"

  if [ -z "${_container_ipv4}" ]; then
    log "ERROR: unable to determine a non-loopback container IPv4 for the direct adb bridge forwarder."
    exit 1
  fi

  if ! command -v socat >/dev/null 2>&1; then
    log "ERROR: socat is unavailable; cannot expose the direct adb bridge on ${_container_ipv4}:${_bridge_port}."
    exit 1
  fi

  : > "${_forwarder_log}"
  (
    tail -n +1 -F "${_forwarder_log}" 2>/dev/null | sed 's/^/[adb-bridge-forwarder] /' >&2
  ) &

  socat \
    "TCP4-LISTEN:${_bridge_port},bind=${_container_ipv4},reuseaddr,fork" \
    "TCP4:127.0.0.1:${_bridge_port}" \
    >"${_forwarder_log}" 2>&1 &

  log "Started direct adb bridge forwarder on ${_container_ipv4}:${_bridge_port} -> 127.0.0.1:${_bridge_port}."
}

supports_direct_radio_override() {
  case "${EMULATOR_USE_RADIO_OVERRIDE}" in
    1|true|TRUE|yes|YES)
      return 0
      ;;
    0|false|FALSE|no|NO|'')
      return 1
      ;;
    auto)
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
  _runtime_dir="${EMULATOR_RUNTIME_DIR:-/tmp/android-unknown}"
  _kernel_log="${_runtime_dir}/kernel.log"
  _logcat_log="${_runtime_dir}/logcat.log"
  _qemu_append="${EMULATOR_QEMU_APPEND:-panic=1}"
  _radio_override_applied=0

  if [ ! -x "${DIRECT_EMULATOR_BIN}" ]; then
    echo "Direct emulator binary is not executable: ${DIRECT_EMULATOR_BIN}" >&2
    exit 1
  fi

  if virtual_display_enabled; then
    start_virtual_x_display
  fi

  ensure_adb_server
  start_direct_adb_bridge_forwarder
  prepare_direct_emulator_logs

  set -- \
    "${DIRECT_EMULATOR_BIN}" \
    -avd Pixel2 \
    -ports "${_ports}" \
    -skip-adb-auth \
    -shell-serial "file:${_kernel_log}" \
    -logcat-output "${_logcat_log}" \
    -feature AllowSnapshotMigration

  if virtual_display_enabled; then
    if ! param_has_flag "-skin" && ! param_has_flag "-no-skin" && ! param_has_flag "-noskin"; then
      set -- "$@" -skin "${EMULATOR_X_CAPTURE_SIZE}"
    fi
    if ! param_has_flag "-fixed-scale"; then
      set -- "$@" -fixed-scale
    fi
  else
    set -- "$@" -no-window
  fi

  if [ -n "${EMULATOR_RADIO_DEVICE}" ] && supports_direct_radio_override; then
    set -- "$@" -radio "${EMULATOR_RADIO_DEVICE}"
    _radio_override_applied=1
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
  log "Direct emulator ports: ${_ports}"
  log "Direct emulator GPU mode: ${EMULATOR_GPU_MODE:-emulator default}"
  log "Direct emulator RAM: ${EMULATOR_RAM_SIZE_MB} MB"
  log "Direct emulator AVD read-only mode: ${EMULATOR_AVD_READ_ONLY}"
  if virtual_display_enabled; then
    log "Direct emulator virtual X display: DISPLAY=${DISPLAY:-unset}, capture size=${EMULATOR_X_CAPTURE_SIZE}"
  else
    log "Direct emulator window: disabled (-no-window)"
  fi
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
# exec chain: start-emulator.sh -> launcher/direct mode -> emulator.
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
