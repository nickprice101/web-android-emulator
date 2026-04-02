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

# NOTE: StrictHostKeyChecking is disabled for automated deployments. For
# production use, replace 'no' with 'yes' and supply a known_hosts file.
SSH_OPTS=(-i "${SSH_KEY_FILE}" -o StrictHostKeyChecking=no -o BatchMode=yes)

# ── Upload repository files (excluding *.md) ─────────────────────────────────
echo "==> Uploading files to ${SSH_USER}@${SSH_IP}:${SSH_PATH} ..."

# Ensure the destination directory exists
ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SSH_IP}" "mkdir -p '${SSH_PATH}'"

rsync -az \
  --exclude='*.md' \
  --exclude='.git/' \
  -e "ssh ${SSH_OPTS[*]}" \
  ./ \
  "${SSH_USER}@${SSH_IP}:${SSH_PATH}/"

echo "    Upload complete."

# ── Build Docker images from sub-directory Dockerfiles ───────────────────────
# Compute image name prefix locally and pass it into the remote environment.
IMAGE_PREFIX="$(basename "${SSH_PATH}")"

for dir in frontend api; do
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SSH_IP}" \
    TARGET="${SSH_PATH}/${dir}" IMAGE_TAG="${IMAGE_PREFIX}-${dir}:latest" \
    bash -s <<'REMOTE'
set -euo pipefail
if [ ! -d "${TARGET}" ]; then
  echo "    [$(basename "${TARGET}")] Directory not found, skipping."
  exit 0
fi
if [ ! -f "${TARGET}/Dockerfile" ]; then
  echo "    [$(basename "${TARGET}")] No Dockerfile found, skipping."
  exit 0
fi
echo "    [$(basename "${TARGET}")] Building Docker image ${IMAGE_TAG} ..."
docker build -t "${IMAGE_TAG}" "${TARGET}"
echo "    [$(basename "${TARGET}")] Build complete."
REMOTE
done

# ── Build the compose stack ───────────────────────────────────────────────────
echo "==> Running 'docker compose build' on root docker-compose.yml ..."
ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SSH_IP}" \
  COMPOSE_DIR="${SSH_PATH}" \
  bash -s <<'REMOTE'
set -euo pipefail
cd "${COMPOSE_DIR}"
docker compose build
echo "    docker compose build complete."
REMOTE

echo "==> All steps completed successfully."
