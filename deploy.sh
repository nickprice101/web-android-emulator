#!/usr/bin/env bash
# deploy.sh – Upload repo files to a remote host via SSH and build Docker images.
#
# Required environment variables:
#   SSH_IP    – Remote host IP or hostname
#   SSH_USER  – SSH login username
#   SSH_B64   – Base64-encoded SSH private key
#   SSH_PATH  – Absolute destination path on the remote host
#
# Usage: ./deploy.sh

set -euo pipefail

# ── Validate required environment variables ───────────────────────────────────
for var in SSH_IP SSH_USER SSH_B64 SSH_PATH; do
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: Required environment variable '${var}' is not set." >&2
    exit 1
  fi
done

# ── Set up SSH key ────────────────────────────────────────────────────────────
SSH_KEY_FILE="$(mktemp)"
trap 'rm -f "${SSH_KEY_FILE}"' EXIT

echo "${SSH_B64}" | base64 --decode > "${SSH_KEY_FILE}"
chmod 600 "${SSH_KEY_FILE}"

SSH_OPTS="-i ${SSH_KEY_FILE} -o StrictHostKeyChecking=no -o BatchMode=yes"

# ── Upload repository files (excluding *.md) ─────────────────────────────────
echo "==> Uploading files to ${SSH_USER}@${SSH_IP}:${SSH_PATH} ..."

# Ensure the destination directory exists
# shellcheck disable=SC2029
ssh ${SSH_OPTS} "${SSH_USER}@${SSH_IP}" "mkdir -p '${SSH_PATH}'"

rsync -az \
  --exclude='*.md' \
  --exclude='.git/' \
  -e "ssh ${SSH_OPTS}" \
  ./ \
  "${SSH_USER}@${SSH_IP}:${SSH_PATH}/"

echo "    Upload complete."

# ── Build Docker images from sub-directory Dockerfiles ───────────────────────
for dir in frontend api; do
  # shellcheck disable=SC2029
  ssh ${SSH_OPTS} "${SSH_USER}@${SSH_IP}" bash <<REMOTE
set -euo pipefail
TARGET="${SSH_PATH}/${dir}"
if [ ! -d "\${TARGET}" ]; then
  echo "    [${dir}] Directory not found, skipping."
  exit 0
fi
if [ ! -f "\${TARGET}/Dockerfile" ]; then
  echo "    [${dir}] No Dockerfile found, skipping."
  exit 0
fi
echo "    [${dir}] Building Docker image ..."
docker build -t "$(basename "${SSH_PATH}")-${dir}:latest" "\${TARGET}"
echo "    [${dir}] Build complete."
REMOTE
done

# ── Build the compose stack ───────────────────────────────────────────────────
echo "==> Running 'docker compose build' on root docker-compose.yml ..."
# shellcheck disable=SC2029
ssh ${SSH_OPTS} "${SSH_USER}@${SSH_IP}" bash <<REMOTE
set -euo pipefail
cd "${SSH_PATH}"
docker compose build
echo "    docker compose build complete."
REMOTE

echo "==> All steps completed successfully."
