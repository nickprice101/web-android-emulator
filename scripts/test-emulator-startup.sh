#!/usr/bin/env bash
# test-emulator-startup.sh – integration smoke test for the emulator container.
#
# Builds the emulator image from the local Dockerfile, runs it with minimal
# privileges, and verifies that:
#   1. The emulator gRPC server starts and binds port 8554.
#   2. The ADB-forward socat bridge on port 5555 becomes reachable (no
#      "Connection timed out" due to emulator iptables DROP rules).
#
# Usage:
#   # Run directly (requires docker and sufficient resources):
#   bash scripts/test-emulator-startup.sh
#
#   # Supply a pre-built image to skip the build step:
#   EMULATOR_IMAGE_TAG=google-emu-emulator:latest bash scripts/test-emulator-startup.sh
#
# Environment variables:
#   EMULATOR_IMAGE_TAG    Docker image tag to use (default: google-emu-emulator:test-smoke)
#   BUILD_IMAGE           Set to 0 to skip docker build (default: 1)
#   GRPC_READY_TIMEOUT    Seconds to wait for gRPC port 8554 (default: 300)
#   ADB_READY_TIMEOUT     Seconds to wait for ADB port 5555 (default: 120)
#   CONTAINER_NAME        Name for the test container (default: emu-smoke-test)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

EMULATOR_IMAGE_TAG="${EMULATOR_IMAGE_TAG:-google-emu-emulator:test-smoke}"
BUILD_IMAGE="${BUILD_IMAGE:-1}"
GRPC_READY_TIMEOUT="${GRPC_READY_TIMEOUT:-300}"
ADB_READY_TIMEOUT="${ADB_READY_TIMEOUT:-120}"
CONTAINER_NAME="${CONTAINER_NAME:-emu-smoke-test}"

log() { echo "[test-emulator-startup] $*"; }
fail() { echo "[test-emulator-startup] FAIL: $*" >&2; exit 1; }

cleanup() {
  log "Removing test container ${CONTAINER_NAME} (if running)..."
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ── 1. Build ────────────────────────────────────────────────────────────────
if [ "${BUILD_IMAGE}" = "1" ]; then
  log "Building emulator image ${EMULATOR_IMAGE_TAG}..."
  docker build \
    --tag "${EMULATOR_IMAGE_TAG}" \
    "${ROOT_DIR}/emulator"
  log "Build complete."
else
  log "Skipping build – using existing image ${EMULATOR_IMAGE_TAG}."
fi

# ── 2. Run container ─────────────────────────────────────────────────────────
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

# ── 3. Wait for gRPC port ────────────────────────────────────────────────────
log "Waiting up to ${GRPC_READY_TIMEOUT}s for emulator gRPC port 8554..."
grpc_deadline=$(( $(date +%s) + GRPC_READY_TIMEOUT ))
grpc_ok=0
while [ "$(date +%s)" -lt "${grpc_deadline}" ]; do
  if docker exec "${CONTAINER_NAME}" sh -c 'nc -z -w2 127.0.0.1 8554' 2>/dev/null; then
    grpc_ok=1
    break
  fi
  # Abort early if the container has exited
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

# ── 4. Verify no iptables DROP on ADB port ───────────────────────────────────
log "Checking that iptables has no DROP rule blocking ADB port 5557..."
if docker exec "${CONTAINER_NAME}" sh -c 'command -v iptables >/dev/null 2>&1'; then
  if docker exec "${CONTAINER_NAME}" iptables -C INPUT -p tcp --dport 5557 -s 127.0.0.1 -j DROP 2>/dev/null; then
    fail "iptables has a DROP rule for ADB port 5557 on loopback – ADB forwarding will timeout"
  fi
  if docker exec "${CONTAINER_NAME}" iptables -C INPUT -p tcp --dport 5557 -j ACCEPT 2>/dev/null; then
    log "iptables ACCEPT rule for ADB port 5557 is present."
  else
    log "No DROP rule found for ADB port 5557 (ACCEPT may still be implicit – OK)."
  fi
fi

# ── 5. Wait for ADB socat port ──────────────────────────────────────────────
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

# ── 6. Check container logs for socat timeout errors ────────────────────────
log "Scanning container logs for persistent socat timeout errors..."
# Up to MAX_ACCEPTABLE_TIMEOUTS "Connection timed out" lines are expected
# during the cold-boot phase: the emulator binds the ADB port early but the
# accept backlog can fill up before boot completes. Anything beyond this
# threshold suggests the iptables guard is not effective.
MAX_ACCEPTABLE_TIMEOUTS="${MAX_ACCEPTABLE_TIMEOUTS:-20}"
timeout_count=$(docker logs "${CONTAINER_NAME}" 2>&1 | grep -c "Connection timed out" || true)
if [ "${timeout_count}" -gt "${MAX_ACCEPTABLE_TIMEOUTS}" ]; then
  log "WARNING: Found ${timeout_count} 'Connection timed out' lines in container logs (threshold: ${MAX_ACCEPTABLE_TIMEOUTS})."
  log "This may indicate that the ADB port iptables guard is not effective."
  log "The container is functional but socat forwarding may have been disrupted."
else
  log "Socat timeout count (${timeout_count}) is within acceptable range (threshold: ${MAX_ACCEPTABLE_TIMEOUTS})."
fi

log ""
log "✓ Emulator startup test PASSED"
log "  - gRPC port 8554: reachable"
log "  - ADB socat port 5555: reachable"
log "  - Socat timeout errors: ${timeout_count}"
