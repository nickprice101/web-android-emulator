#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

stage() {
  echo
  echo "[testbed] ===== $1 ====="
}

stage "stage 1: dependency/bootstrap checks"
echo "[testbed] preparing Node dependencies"
npm --prefix frontend ci
npm --prefix bridge-webrtc ci

if [[ "${BRIDGE_WRTC_BUILD_FORK:-0}" == "1" ]]; then
  echo "[testbed] building forked @roamhq/wrtc binary for ${OSTYPE:-unknown}"
  npm --prefix bridge-webrtc run build:wrtc-fork
fi

echo "[testbed] preparing Python virtual environment"
python3 -m venv .venv-testbed
# shellcheck disable=SC1091
source .venv-testbed/bin/activate
pip install --upgrade pip >/dev/null
pip install -r apkbridge/requirements.txt >/dev/null

stage "stage 2: apkbridge validation"
echo "[testbed] running apkbridge unit tests"
python -m unittest discover -s apkbridge/tests -v

stage "stage 3: bridge relay and media validation"
echo "[testbed] running bridge-webrtc unit tests"
node --test --test-force-exit bridge-webrtc/test/*.test.mjs

stage "stage 4: native emulator WebRTC signaling guards"
echo "[testbed] running native WebRTC configuration checks"
node scripts/test-native-webrtc.mjs

stage "stage 5: frontend production build"
echo "[testbed] running frontend build"
npm --prefix frontend run build

stage "stage 6: optional TURN reachability/auth harness"
if [[ -n "${TURN_HOST:-}" && -n "${TURN_KEY:-}" ]]; then
  echo "[testbed] running TURN connectivity harness"
  node bridge-webrtc/test/turn-connectivity-harness.mjs
else
  echo "[testbed] skipping TURN harness (set TURN_HOST and TURN_KEY to run it)"
fi

stage "stage 7: optional emulator container startup smoke test"
if [[ "${RUN_EMULATOR_STARTUP_TEST:-0}" == "1" ]]; then
  echo "[testbed] running emulator startup smoke test"
  bash scripts/test-emulator-startup.sh
else
  echo "[testbed] skipping emulator startup smoke test (set RUN_EMULATOR_STARTUP_TEST=1 to run it)"
fi

stage "stage 8: optional deployed video-stream validation"
if [[ "${RUN_EMULATOR_STREAM_TEST:-0}" == "1" || -n "${E2E_BASE_URL:-}" ]]; then
  echo "[testbed] running deployed Playwright video-stream validation"
  npm --prefix frontend run test:e2e:deployed-turns
else
  echo "[testbed] skipping deployed video-stream validation (set RUN_EMULATOR_STREAM_TEST=1 or E2E_BASE_URL to run it)"
fi

echo "[testbed] all checks passed"
