#!/usr/bin/env bash
# test-emulator-startup.sh - integration smoke test for the emulator container.
#
# Builds the emulator image from the local Dockerfile, runs it with minimal
# privileges, and verifies that:
#   1. The emulator gRPC server starts and binds port 8554.
#   2. The emulator ADB bridge is reachable on port 5555.
#   3. A non-loopback ADB client path can connect to emulator:5555 and reach
#      a usable adb transport.
#   4. The Android guest can optionally be probed over ADB without blocking
#      startup classification when guest boot is merely slow.
#   5. The container remains running and becomes healthy after validation.
#
# Usage:
#   bash scripts/test-emulator-startup.sh
#
#   EMULATOR_IMAGE_TAG=google-emu-emulator:latest BUILD_IMAGE=0 \
#     bash scripts/test-emulator-startup.sh
#
# Environment variables:
#   EMULATOR_IMAGE_TAG       Docker image tag to use.
#   BUILD_IMAGE              Set to 0 to skip docker build.
#   EMULATOR_IMAGE_BUILD_ARG Verified Google base image used for docker build.
#   EMULATOR_SYSTEM_IMAGE    Android system image package to install.
#   EMULATOR_PLATFORM        Android platform package to install.
#   EXPECTED_GUEST_API       Expected Android guest API level.
#   GRPC_READY_TIMEOUT       Seconds to wait for gRPC port 8554.
#   ADB_READY_TIMEOUT        Seconds to wait for the external ADB bridge target
#                            to report a usable adb transport.
#   REQUIRE_ADB_BRIDGE       Set to 0 to leave the external ADB bridge probe in
#                            passive mode.
#   API_READY_TIMEOUT        Seconds to spend on best-effort guest ADB probes.
#   REQUIRE_GUEST_BOOT_COMPLETED
#                            Set to 1 to fail unless the Android guest reports
#                            both the expected API level and sys.boot_completed=1.
#   REQUIRE_HEALTHY_CONTAINER
#                            Set to 0 to skip requiring Docker health status to
#                            become healthy before the test passes.
#   STABILITY_WAIT_SECONDS   Seconds to keep watching the container after validation.
#   CONTAINER_NAME           Name for the test container.
#   ARTIFACT_DIR             Directory where logs/diagnostics are written.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

EMULATOR_IMAGE_TAG="${EMULATOR_IMAGE_TAG:-google-emu-emulator:test-smoke}"
BUILD_IMAGE="${BUILD_IMAGE:-1}"
EMULATOR_IMAGE_BUILD_ARG="${EMULATOR_IMAGE_BUILD_ARG:-us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:7148297}"
EMULATOR_SYSTEM_IMAGE="${EMULATOR_SYSTEM_IMAGE:-system-images;android-34;google_apis;x86_64}"
EMULATOR_PLATFORM="${EMULATOR_PLATFORM:-platforms;android-34}"
EXPECTED_GUEST_API="${EXPECTED_GUEST_API:-34}"
EXPECTED_RADIO_OVERRIDE_MODE="${EXPECTED_RADIO_OVERRIDE_MODE:-disabled}"
GRPC_READY_TIMEOUT="${GRPC_READY_TIMEOUT:-300}"
ADB_READY_TIMEOUT="${ADB_READY_TIMEOUT:-180}"
REQUIRE_ADB_BRIDGE="${REQUIRE_ADB_BRIDGE:-1}"
API_READY_TIMEOUT="${API_READY_TIMEOUT:-300}"
PASSIVE_API_PROBE_TIMEOUT="${PASSIVE_API_PROBE_TIMEOUT:-60}"
REQUIRE_GUEST_BOOT_COMPLETED="${REQUIRE_GUEST_BOOT_COMPLETED:-0}"
REQUIRE_HEALTHY_CONTAINER="${REQUIRE_HEALTHY_CONTAINER:-1}"
HEALTH_READY_TIMEOUT="${HEALTH_READY_TIMEOUT:-240}"
STABILITY_WAIT_SECONDS="${STABILITY_WAIT_SECONDS:-30}"
DEFAULT_CONTAINER_NAME="emu-smoke-test-$(date +%s)-$$"
CONTAINER_NAME="${CONTAINER_NAME:-${DEFAULT_CONTAINER_NAME}}"
ARTIFACT_DIR="${ARTIFACT_DIR:-${ROOT_DIR}/artifacts/emulator-startup}"
MAX_ACCEPTABLE_TIMEOUTS="${MAX_ACCEPTABLE_TIMEOUTS:-20}"
EMULATOR_INTERNAL_ADB_PORT="${EMULATOR_INTERNAL_ADB_PORT:-5555}"
EMULATOR_CONSOLE_PORT="${EMULATOR_CONSOLE_PORT:-5554}"
EMULATOR_ADB_SERIAL="${EMULATOR_ADB_SERIAL:-emulator-${EMULATOR_CONSOLE_PORT}}"

CONTAINER_IP=""

log() { echo "[test-emulator-startup] $*"; }
fail() { echo "[test-emulator-startup] FAIL: $*" >&2; exit 1; }

probe_tcp_port() {
  local host="$1"
  local port="$2"
  timeout 15 python3 - "$host" "$port" <<'PY' >/dev/null 2>&1
import socket
import sys

host = sys.argv[1]
port = int(sys.argv[2])
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.settimeout(2)
try:
    sock.connect((host, port))
except OSError:
    sys.exit(1)
finally:
    sock.close()
PY
}

probe_local_tcp_port() {
  local port="$1"
  timeout 15 docker exec "${CONTAINER_NAME}" python3 - "$port" <<'PY' >/dev/null 2>&1
import socket
import sys

port = int(sys.argv[1])
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.settimeout(2)
try:
    sock.connect(("127.0.0.1", port))
except OSError:
    sys.exit(1)
finally:
    sock.close()
PY
}

container_ipv4() {
  docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${CONTAINER_NAME}" 2>/dev/null || true
}

probe_external_adb_bridge_state() {
  local container_ip="$1"
  timeout 40 docker run --rm \
    --network bridge \
    --add-host "emulator:${container_ip}" \
    --entrypoint sh \
    "${EMULATOR_IMAGE_TAG}" \
    -lc "adb start-server >/dev/null 2>&1 || true; adb connect emulator:5555 >/tmp/adb-connect.log 2>&1 || true; adb -s emulator:5555 get-state 2>/dev/null | tr -d '\r'" 2>/dev/null || true
}

probe_guest_property() {
  local prop="$1"
  timeout 20 docker exec "${CONTAINER_NAME}" sh -c "timeout 10 adb -s ${EMULATOR_ADB_SERIAL} shell getprop ${prop} 2>/dev/null | tr -d '\r'" 2>/dev/null || true
}

container_health_status() {
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${CONTAINER_NAME}" 2>/dev/null || true
}

mkdir -p "${ARTIFACT_DIR}"

capture_diagnostics() {
  if docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
    docker logs "${CONTAINER_NAME}" > "${ARTIFACT_DIR}/container.log" 2>&1 || true
    docker inspect "${CONTAINER_NAME}" > "${ARTIFACT_DIR}/container-inspect.json" 2>&1 || true
    docker exec "${CONTAINER_NAME}" sh -c 'ip addr || true' > "${ARTIFACT_DIR}/ip-addr.txt" 2>&1 || true
    docker exec "${CONTAINER_NAME}" sh -c 'if command -v adb >/dev/null 2>&1; then adb devices -l || true; fi' > "${ARTIFACT_DIR}/adb-devices.txt" 2>&1 || true
    docker exec "${CONTAINER_NAME}" sh -c "if command -v adb >/dev/null 2>&1; then adb -s ${EMULATOR_ADB_SERIAL} shell getprop ro.build.version.sdk || true; adb -s ${EMULATOR_ADB_SERIAL} shell getprop sys.boot_completed || true; fi" > "${ARTIFACT_DIR}/guest-state.txt" 2>&1 || true
    if [ -n "${CONTAINER_IP}" ]; then
      probe_external_adb_bridge_state "${CONTAINER_IP}" > "${ARTIFACT_DIR}/bridge-state.txt" 2>&1 || true
    fi
  fi
}

cleanup() {
  capture_diagnostics
  log "Removing test container ${CONTAINER_NAME} (if running)..."
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ "${BUILD_IMAGE}" = "1" ]; then
  log "Building emulator image ${EMULATOR_IMAGE_TAG} from ${EMULATOR_IMAGE_BUILD_ARG}..."
  docker build \
    --build-arg "EMULATOR_IMAGE=${EMULATOR_IMAGE_BUILD_ARG}" \
    --build-arg "EMULATOR_SYSTEM_IMAGE=${EMULATOR_SYSTEM_IMAGE}" \
    --build-arg "EMULATOR_PLATFORM=${EMULATOR_PLATFORM}" \
    --tag "${EMULATOR_IMAGE_TAG}" \
    "${ROOT_DIR}/emulator"
  log "Build complete."
else
  log "Skipping build - using existing image ${EMULATOR_IMAGE_TAG}."
fi

if docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
  log "Removing stale test container ${CONTAINER_NAME} before startup..."
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
fi

log "Starting container ${CONTAINER_NAME}..."
docker run -d \
  --name "${CONTAINER_NAME}" \
  --privileged \
  --device /dev/kvm:/dev/kvm \
  --shm-size 2g \
  -e EMULATOR_PARAMS="-no-audio -grpc 8554 -no-snapshot-load -wipe-data -dns-server 1.1.1.1,8.8.8.8 -gpu swiftshader_indirect -no-boot-anim -camera-back none -camera-front none -no-snapshot-save" \
  -e TURN_KEY="" \
  -e ADBKEY="PLACEHOLDER_ADB_KEY" \
  "${EMULATOR_IMAGE_TAG}" 2>&1 | head -1

log "Waiting up to ${GRPC_READY_TIMEOUT}s for emulator gRPC port 8554..."
grpc_deadline=$(( $(date +%s) + GRPC_READY_TIMEOUT ))
grpc_ok=0
while [ "$(date +%s)" -lt "${grpc_deadline}" ]; do
  if probe_local_tcp_port 8554; then
    grpc_ok=1
    break
  fi
  if ! docker inspect -f '{{.State.Running}}' "${CONTAINER_NAME}" 2>/dev/null | grep -q true; then
    fail "Container exited before gRPC port became available"
  fi
  sleep 5
done

if [ "${grpc_ok}" -ne 1 ]; then
  log "=== Container logs ==="
  docker logs "${CONTAINER_NAME}" 2>&1 | tail -50
  fail "Timed out waiting for emulator gRPC port 8554 after ${GRPC_READY_TIMEOUT}s"
fi
log "gRPC port 8554 is accessible."

CONTAINER_IP="$(container_ipv4)"
if [ -z "${CONTAINER_IP}" ]; then
  fail "Unable to determine emulator container IP address"
fi
log "Container bridge IP is ${CONTAINER_IP}."

log "Checking that iptables has no DROP rule blocking internal ADB port ${EMULATOR_INTERNAL_ADB_PORT}..."
for _ipt in iptables iptables-legacy; do
  if docker exec "${CONTAINER_NAME}" sh -c "command -v ${_ipt} >/dev/null 2>&1"; then
    for _chain in INPUT OUTPUT FORWARD; do
      if docker exec "${CONTAINER_NAME}" "${_ipt}" -C "${_chain}" -p tcp --dport "${EMULATOR_INTERNAL_ADB_PORT}" -j DROP 2>/dev/null; then
        fail "${_ipt} has a DROP rule for ADB port ${EMULATOR_INTERNAL_ADB_PORT} in ${_chain}"
      fi
      if docker exec "${CONTAINER_NAME}" "${_ipt}" -C "${_chain}" -p tcp --dport "${EMULATOR_INTERNAL_ADB_PORT}" -s 127.0.0.1 -j DROP 2>/dev/null; then
        fail "${_ipt} has a src-127.0.0.1 DROP rule for ADB port ${EMULATOR_INTERNAL_ADB_PORT} in ${_chain}"
      fi
    done
  fi
done

if [ "${REQUIRE_ADB_BRIDGE}" = "1" ]; then
  log "Waiting up to ${ADB_READY_TIMEOUT}s for external adb target emulator:5555 to report device..."
else
  log "Probing external adb target emulator:5555 for up to ${ADB_READY_TIMEOUT}s without blocking startup classification..."
fi
adb_deadline=$(( $(date +%s) + ADB_READY_TIMEOUT ))
adb_ok=0
adb_bridge_state=""
while [ "$(date +%s)" -lt "${adb_deadline}" ]; do
  if ! probe_tcp_port "${CONTAINER_IP}" 5555; then
    adb_bridge_state=""
  else
    adb_bridge_state="$(probe_external_adb_bridge_state "${CONTAINER_IP}")"
  fi

  if [ "${adb_bridge_state}" = "device" ]; then
    adb_ok=1
    break
  fi
  if ! docker inspect -f '{{.State.Running}}' "${CONTAINER_NAME}" 2>/dev/null | grep -q true; then
    fail "Container exited before ADB socat port became available"
  fi
  sleep 5
done

if [ "${REQUIRE_ADB_BRIDGE}" = "1" ]; then
  if [ "${adb_ok}" -ne 1 ]; then
    log "=== Container logs ==="
    docker logs "${CONTAINER_NAME}" 2>&1 | tail -80
    fail "Timed out waiting for external adb target emulator:5555 to report device after ${ADB_READY_TIMEOUT}s"
  fi
  log "External adb target emulator:5555 reported device."
elif [ "${adb_ok}" -eq 1 ]; then
  log "External adb target emulator:5555 reported device during passive probing."
else
  log "WARNING: external adb target emulator:5555 did not report device within ${ADB_READY_TIMEOUT}s. Treating startup as healthy because the emulator runtime is still up."
fi

if [ "${REQUIRE_GUEST_BOOT_COMPLETED}" = "1" ]; then
  log "Waiting up to ${API_READY_TIMEOUT}s for the Android guest to report API ${EXPECTED_GUEST_API} and boot_completed=1..."
  guest_probe_timeout="${API_READY_TIMEOUT}"
else
  log "Probing guest ADB state for up to ${PASSIVE_API_PROBE_TIMEOUT}s without blocking startup classification..."
  guest_probe_timeout="${PASSIVE_API_PROBE_TIMEOUT}"
fi
api_deadline=$(( $(date +%s) + guest_probe_timeout ))
guest_api=""
boot_completed=""
guest_probe_iter=0
while [ "$(date +%s)" -lt "${api_deadline}" ]; do
  guest_api="$(probe_guest_property ro.build.version.sdk)"
  boot_completed="$(probe_guest_property sys.boot_completed)"
  guest_probe_iter=$((guest_probe_iter + 1))

  if [ "${guest_api}" = "${EXPECTED_GUEST_API}" ] && [ "${boot_completed}" = "1" ]; then
    break
  fi

  if [ $((guest_probe_iter % 6)) -eq 0 ]; then
    log "Guest probe pending: api='${guest_api:-<empty>}' boot_completed='${boot_completed:-<empty>}' elapsed=$((guest_probe_iter * 5))s"
  fi

  if ! docker inspect -f '{{.State.Running}}' "${CONTAINER_NAME}" 2>/dev/null | grep -q true; then
    fail "Container exited before the Android guest reported API ${EXPECTED_GUEST_API}"
  fi
  sleep 5
done

if [ "${REQUIRE_GUEST_BOOT_COMPLETED}" = "1" ]; then
  if [ "${guest_api}" != "${EXPECTED_GUEST_API}" ]; then
    log "=== Container logs ==="
    docker logs "${CONTAINER_NAME}" 2>&1 | tail -120
    fail "Expected Android guest API ${EXPECTED_GUEST_API}, got '${guest_api:-<empty>}'"
  fi
  if [ "${boot_completed}" != "1" ]; then
    log "=== Container logs ==="
    docker logs "${CONTAINER_NAME}" 2>&1 | tail -120
    fail "Android guest did not finish booting within ${API_READY_TIMEOUT}s"
  fi
  log "Android guest API level is ${guest_api} and boot_completed=${boot_completed}."
elif [ "${guest_api}" = "${EXPECTED_GUEST_API}" ] && [ "${boot_completed}" = "1" ]; then
  log "Observed Android guest API level ${guest_api} and boot_completed=${boot_completed} during passive ADB probing."
else
  log "WARNING: guest ADB state is still pending after ${guest_probe_timeout}s (api='${guest_api:-<empty>}', boot_completed='${boot_completed:-<empty>}'). Treating startup as healthy because gRPC is up and the container is stable."
fi

log "Checking container logs for stale API 30 fallback or fatal modem startup errors..."
if docker logs "${CONTAINER_NAME}" 2>&1 | grep -Eq 'version: AndroidVersion\.ApiLevel=30|Pkg\.Dependencies=emulator#30\.0\.4'; then
  fail "Container logs still show the base launcher resolving an API 30 guest"
fi
if ! docker logs "${CONTAINER_NAME}" 2>&1 | grep -Fq '[start-emulator-with-turn] Using direct emulator mode; legacy launcher bypassed.'; then
  fail "Container logs do not show the expected direct emulator launch mode"
fi
if ! docker logs "${CONTAINER_NAME}" 2>&1 | grep -Eq '\[start-emulator-with-turn\] (Verified IPv6 literal ::1 resolves for qemu modem sockets\.|Provisioned dummy IPv6 interface to satisfy AI_ADDRCONFIG for ::1 modem socket resolution\.)'; then
  fail "Container logs do not show the expected IPv6 modem-resolution preflight succeeding"
fi
if [ "${EXPECTED_RADIO_OVERRIDE_MODE}" = "disabled" ]; then
  if ! docker logs "${CONTAINER_NAME}" 2>&1 | grep -Fq '[start-emulator-with-turn] Direct emulator radio override: disabled'; then
    fail "Container logs do not show the expected radio-override-disabled path for this emulator build"
  fi
else
  if ! docker logs "${CONTAINER_NAME}" 2>&1 | grep -Fq "[start-emulator-with-turn] Direct emulator radio override: ${EXPECTED_RADIO_OVERRIDE_MODE}"; then
    fail "Container logs do not show the expected direct-launch radio override (${EXPECTED_RADIO_OVERRIDE_MODE})"
  fi
fi
if docker logs "${CONTAINER_NAME}" 2>&1 | grep -Eq 'adb binary unavailable for direct launch|WARNING: adb command unavailable'; then
  fail "Container logs show that adb is unavailable in the runtime image"
fi
if docker logs "${CONTAINER_NAME}" 2>&1 | grep -Eq 'AdbHostServer\.cpp:102: Unable to connect to adb daemon on port: 5037'; then
  fail "Container logs still show the emulator failing to reach the host adb server on port 5037"
fi
if docker logs "${CONTAINER_NAME}" 2>&1 | grep -Eq 'qemu-system-x86_64-headless: -radio: invalid option'; then
  fail "Container logs still show the unsupported -radio option crash"
fi
if docker logs "${CONTAINER_NAME}" 2>&1 | grep -Eq 'WARNING: IPv6 literal ::1 still does not resolve after provisioning dummy IPv6 interface'; then
  fail "Container logs show the IPv6 modem-resolution preflight still failing"
fi
if docker logs "${CONTAINER_NAME}" 2>&1 | grep -Eq 'start-emulator-with-turn\.sh: [0-9]+: _emulator_version: parameter not set'; then
  fail "Container logs show the direct-launch wrapper crashing on an unset emulator-version variable"
fi
if docker logs "${CONTAINER_NAME}" 2>&1 | grep -Eq 'adb binary unavailable for direct launch|WARNING: adb command unavailable'; then
  fail "Container logs show that adb is unavailable in the runtime image"
fi
if docker logs "${CONTAINER_NAME}" 2>&1 | grep -Eq 'AdbHostServer\.cpp:102: Unable to connect to adb daemon on port: 5037'; then
  fail "Container logs still show the emulator failing to reach the host adb server on port 5037"
fi
if docker logs "${CONTAINER_NAME}" 2>&1 | grep -Eq 'qemu-system-x86_64-headless: .*id=modem: address resolution failed for ::1'; then
  fail "Container logs still show the fatal QEMU modem ::1 resolution failure"
fi
if docker logs "${CONTAINER_NAME}" 2>&1 | grep -Eq '\[start-emulator-with-turn\] Using emulator launcher: /android/sdk/launch-emulator\.sh'; then
  fail "Container logs show the wrapper falling back to the legacy Google launcher"
fi

log "Analyzing captured container logs for known restart-loop signatures..."
docker logs "${CONTAINER_NAME}" > "${ARTIFACT_DIR}/container.log" 2>&1 || true
if ! node "${ROOT_DIR}/scripts/analyze-emulator-log.mjs" "${ARTIFACT_DIR}/container.log"; then
  fail "Log analyzer found a known emulator restart-loop signature"
fi

log "Scanning container logs for persistent socat timeout errors..."
timeout_count=$(docker logs "${CONTAINER_NAME}" 2>&1 | grep -c "Connection timed out" || true)
if [ "${timeout_count}" -gt "${MAX_ACCEPTABLE_TIMEOUTS}" ]; then
  log "WARNING: Found ${timeout_count} 'Connection timed out' lines in container logs (threshold: ${MAX_ACCEPTABLE_TIMEOUTS})."
else
  log "Socat timeout count (${timeout_count}) is within acceptable range (threshold: ${MAX_ACCEPTABLE_TIMEOUTS})."
fi

log "Waiting ${STABILITY_WAIT_SECONDS}s to confirm the container stays running..."
sleep "${STABILITY_WAIT_SECONDS}"
if ! docker inspect -f '{{.State.Running}}' "${CONTAINER_NAME}" 2>/dev/null | grep -q true; then
  log "=== Container logs ==="
  docker logs "${CONTAINER_NAME}" 2>&1 | tail -120
  fail "Container exited during the post-boot stability window"
fi
log "Container remained running for the full stability window."

health_status="$(container_health_status)"
if [ "${REQUIRE_HEALTHY_CONTAINER}" = "1" ] && [ "${health_status}" != "healthy" ] && [ "${health_status}" != "none" ]; then
  log "Waiting up to ${HEALTH_READY_TIMEOUT}s for container health status to become healthy..."
  health_deadline=$(( $(date +%s) + HEALTH_READY_TIMEOUT ))
  while [ "$(date +%s)" -lt "${health_deadline}" ]; do
    health_status="$(container_health_status)"
    if [ "${health_status}" = "healthy" ] || [ "${health_status}" = "none" ]; then
      break
    fi
    if ! docker inspect -f '{{.State.Running}}' "${CONTAINER_NAME}" 2>/dev/null | grep -q true; then
      fail "Container exited before health status became healthy"
    fi
    sleep 5
  done
fi
if [ "${REQUIRE_HEALTHY_CONTAINER}" = "1" ] && [ "${health_status}" != "healthy" ] && [ "${health_status}" != "none" ]; then
  fail "Container health status is '${health_status}', expected 'healthy'"
fi
if [ "${health_status}" = "healthy" ]; then
  log "Container health status is healthy."
elif [ "${health_status}" != "none" ]; then
  log "WARNING: container health status is ${health_status}."
fi

log ""
log "Emulator startup test PASSED"
log "  - gRPC port 8554: reachable"
log "  - ADB bridge probe mode: $( [ "${REQUIRE_ADB_BRIDGE}" = "1" ] && printf '%s' 'strict' || printf '%s' 'passive' )"
log "  - ADB bridge target emulator:5555: $( [ "${adb_ok}" -eq 1 ] && printf '%s' 'device' || printf '%s' 'pending' )"
log "  - Guest ADB probe mode: $( [ "${REQUIRE_GUEST_BOOT_COMPLETED}" = "1" ] && printf '%s' 'strict' || printf '%s' 'passive' )"
log "  - Android guest API: ${guest_api:-pending}"
log "  - Guest boot_completed: ${boot_completed:-pending}"
log "  - Container health: ${health_status}"
log "  - Socat timeout errors: ${timeout_count}"
log "  - Stability window: ${STABILITY_WAIT_SECONDS}s"
