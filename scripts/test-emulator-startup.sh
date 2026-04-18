#!/usr/bin/env bash
# test-emulator-startup.sh - integration smoke test for the emulator container.
#
# Builds the emulator image from the local Dockerfile, runs it with minimal
# privileges, and verifies that:
#   1. The emulator gRPC server starts and binds port 8554.
#   2. The ADB-forward socat bridge on port 5555 becomes reachable.
#   3. The Android guest reports the expected API level over ADB.
#   4. The container remains running after the guest becomes reachable.
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
#   ADB_READY_TIMEOUT        Seconds to wait for ADB port 5555.
#   API_READY_TIMEOUT        Seconds to wait for boot/API checks over ADB.
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
EXPECTED_RADIO_DEVICE="${EXPECTED_RADIO_DEVICE:-null}"
GRPC_READY_TIMEOUT="${GRPC_READY_TIMEOUT:-300}"
ADB_READY_TIMEOUT="${ADB_READY_TIMEOUT:-180}"
API_READY_TIMEOUT="${API_READY_TIMEOUT:-300}"
STABILITY_WAIT_SECONDS="${STABILITY_WAIT_SECONDS:-30}"
CONTAINER_NAME="${CONTAINER_NAME:-emu-smoke-test}"
ARTIFACT_DIR="${ARTIFACT_DIR:-${ROOT_DIR}/artifacts/emulator-startup}"
MAX_ACCEPTABLE_TIMEOUTS="${MAX_ACCEPTABLE_TIMEOUTS:-20}"
EMULATOR_INTERNAL_ADB_PORT="${EMULATOR_INTERNAL_ADB_PORT:-5555}"

log() { echo "[test-emulator-startup] $*"; }
fail() { echo "[test-emulator-startup] FAIL: $*" >&2; exit 1; }

mkdir -p "${ARTIFACT_DIR}"

capture_diagnostics() {
  if docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
    docker logs "${CONTAINER_NAME}" > "${ARTIFACT_DIR}/container.log" 2>&1 || true
    docker inspect "${CONTAINER_NAME}" > "${ARTIFACT_DIR}/container-inspect.json" 2>&1 || true
    docker exec "${CONTAINER_NAME}" sh -c 'ip addr || true' > "${ARTIFACT_DIR}/ip-addr.txt" 2>&1 || true
    docker exec "${CONTAINER_NAME}" sh -c 'if command -v adb >/dev/null 2>&1; then adb devices -l || true; fi' > "${ARTIFACT_DIR}/adb-devices.txt" 2>&1 || true
    docker exec "${CONTAINER_NAME}" sh -c 'if command -v adb >/dev/null 2>&1; then adb connect 127.0.0.1:5555 >/dev/null 2>&1 || true; adb -s 127.0.0.1:5555 shell getprop ro.build.version.sdk || true; adb -s 127.0.0.1:5555 shell getprop sys.boot_completed || true; fi' > "${ARTIFACT_DIR}/guest-state.txt" 2>&1 || true
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

log "Starting container ${CONTAINER_NAME}..."
docker run -d \
  --name "${CONTAINER_NAME}" \
  --privileged \
  --device /dev/kvm:/dev/kvm \
  --shm-size 2g \
  -e EMULATOR_PARAMS="-no-audio -grpc 8554 -no-snapshot-load -wipe-data -dns-server 1.1.1.1,8.8.8.8 -gpu swiftshader_indirect -no-boot-anim -camera-back none -camera-front none -no-snapshot-save" \
  -e TURN_KEY="" \
  -e ADBKEY="PLACEHOLDER_ADB_KEY" \
  -p 18554:8554 \
  -p 15555:5555 \
  "${EMULATOR_IMAGE_TAG}" 2>&1 | head -1

log "Waiting up to ${GRPC_READY_TIMEOUT}s for emulator gRPC port 8554..."
grpc_deadline=$(( $(date +%s) + GRPC_READY_TIMEOUT ))
grpc_ok=0
while [ "$(date +%s)" -lt "${grpc_deadline}" ]; do
  if docker exec "${CONTAINER_NAME}" sh -c 'nc -z -w2 127.0.0.1 8554' 2>/dev/null; then
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

log "Waiting up to ${ADB_READY_TIMEOUT}s for ADB socat port 5555 to accept connections..."
adb_deadline=$(( $(date +%s) + ADB_READY_TIMEOUT ))
adb_ok=0
while [ "$(date +%s)" -lt "${adb_deadline}" ]; do
  if docker exec "${CONTAINER_NAME}" sh -c 'nc -z -w2 127.0.0.1 5555' 2>/dev/null; then
    adb_ok=1
    break
  fi
  if ! docker inspect -f '{{.State.Running}}' "${CONTAINER_NAME}" 2>/dev/null | grep -q true; then
    fail "Container exited before ADB socat port became available"
  fi
  sleep 5
done

if [ "${adb_ok}" -ne 1 ]; then
  log "=== Container logs ==="
  docker logs "${CONTAINER_NAME}" 2>&1 | tail -80
  fail "Timed out waiting for ADB socat port 5555 after ${ADB_READY_TIMEOUT}s"
fi
log "ADB socat port 5555 is accessible."

log "Waiting up to ${API_READY_TIMEOUT}s for the Android guest to report API ${EXPECTED_GUEST_API}..."
api_deadline=$(( $(date +%s) + API_READY_TIMEOUT ))
guest_api=""
boot_completed=""
while [ "$(date +%s)" -lt "${api_deadline}" ]; do
  docker exec "${CONTAINER_NAME}" sh -c 'adb connect 127.0.0.1:5555 >/tmp/adb-connect.log 2>&1 || true' >/dev/null 2>&1 || true
  docker exec "${CONTAINER_NAME}" sh -c 'timeout 15 adb -s 127.0.0.1:5555 wait-for-device >/tmp/adb-wait.log 2>&1 || true' >/dev/null 2>&1 || true

  guest_api="$(docker exec "${CONTAINER_NAME}" sh -c 'adb -s 127.0.0.1:5555 shell getprop ro.build.version.sdk 2>/dev/null | tr -d "\r"' 2>/dev/null || true)"
  boot_completed="$(docker exec "${CONTAINER_NAME}" sh -c 'adb -s 127.0.0.1:5555 shell getprop sys.boot_completed 2>/dev/null | tr -d "\r"' 2>/dev/null || true)"

  if [ "${guest_api}" = "${EXPECTED_GUEST_API}" ] && [ "${boot_completed}" = "1" ]; then
    break
  fi

  if ! docker inspect -f '{{.State.Running}}' "${CONTAINER_NAME}" 2>/dev/null | grep -q true; then
    fail "Container exited before the Android guest reported API ${EXPECTED_GUEST_API}"
  fi
  sleep 5
done

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

log "Checking container logs for stale API 30 fallback or fatal modem startup errors..."
if docker logs "${CONTAINER_NAME}" 2>&1 | grep -Eq 'version: AndroidVersion\.ApiLevel=30|Pkg\.Dependencies=emulator#30\.0\.4'; then
  fail "Container logs still show the base launcher resolving an API 30 guest"
fi
if ! docker logs "${CONTAINER_NAME}" 2>&1 | grep -Fq '[start-emulator-with-turn] Using direct emulator mode; legacy launcher bypassed.'; then
  fail "Container logs do not show the expected direct emulator launch mode"
fi
if ! docker logs "${CONTAINER_NAME}" 2>&1 | grep -Fq "[start-emulator-with-turn] Direct emulator radio device: ${EXPECTED_RADIO_DEVICE}"; then
  fail "Container logs do not show the expected direct-launch radio backend (${EXPECTED_RADIO_DEVICE})"
fi
if docker logs "${CONTAINER_NAME}" 2>&1 | grep -Eq 'qemu-system-x86_64-headless: .*id=modem: address resolution failed for ::1'; then
  fail "Container logs still show the fatal QEMU modem ::1 resolution failure"
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

log ""
log "Emulator startup test PASSED"
log "  - gRPC port 8554: reachable"
log "  - ADB socat port 5555: reachable"
log "  - Android guest API: ${guest_api}"
log "  - Socat timeout errors: ${timeout_count}"
log "  - Stability window: ${STABILITY_WAIT_SECONDS}s"
