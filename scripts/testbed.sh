#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[testbed] preparing Node dependencies"
npm --prefix frontend ci
npm --prefix bridge-webrtc ci

echo "[testbed] preparing Python virtual environment"
python3 -m venv .venv-testbed
# shellcheck disable=SC1091
source .venv-testbed/bin/activate
pip install --upgrade pip >/dev/null
pip install -r apkbridge/requirements.txt >/dev/null

echo "[testbed] running apkbridge unit tests"
python -m unittest discover -s apkbridge/tests -v

echo "[testbed] running bridge-webrtc unit tests"
node --test bridge-webrtc/test/*.test.mjs

echo "[testbed] running frontend build"
npm --prefix frontend run build

echo "[testbed] all checks passed"
