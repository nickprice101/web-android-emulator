#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

NPM_BIN="${NPM_BIN:-npm}"
NODE_BIN="${NODE_BIN:-node}"
PYTHON3_BIN="${PYTHON3_BIN:-python3}"
PYTHON_BIN="${PYTHON_BIN:-python}"

run_npm() {
  "$NPM_BIN" "$@"
}

run_node() {
  "$NODE_BIN" "$@"
}

run_python3() {
  "$PYTHON3_BIN" "$@"
}

run_python() {
  "$PYTHON_BIN" "$@"
}

stage() {
  echo
  echo "[testbed] ===== $1 ====="
}

stage "stage 1: dependency/bootstrap checks"
echo "[testbed] preparing Node dependencies"
run_npm --prefix frontend ci

echo "[testbed] preparing Python virtual environment"
run_python3 -m venv .venv-testbed

if [[ -x ".venv-testbed/bin/python" ]]; then
  VENV_PYTHON=".venv-testbed/bin/python"
elif [[ -x ".venv-testbed/Scripts/python.exe" ]]; then
  VENV_PYTHON=".venv-testbed/Scripts/python.exe"
else
  echo "[testbed] unable to locate the virtualenv Python interpreter"
  exit 1
fi

"$VENV_PYTHON" -m pip install -r apkbridge/requirements.txt >/dev/null

stage "stage 2: apkbridge validation"
echo "[testbed] running apkbridge unit tests"
"$VENV_PYTHON" -m unittest discover -s apkbridge/tests -v

stage "stage 3: Guacamole-style HTTP tunnel configuration guards"
echo "[testbed] running Guacamole-style HTTP configuration checks"
run_node scripts/test-guacamole-http.mjs

stage "stage 4: frontend production build"
echo "[testbed] running frontend build"
run_npm --prefix frontend run build

stage "stage 5: optional emulator container startup smoke test"
if [[ "${RUN_EMULATOR_STARTUP_TEST:-0}" == "1" ]]; then
  echo "[testbed] running emulator startup smoke test"
  bash scripts/test-emulator-startup.sh
else
  echo "[testbed] skipping emulator startup smoke test (set RUN_EMULATOR_STARTUP_TEST=1 to run it)"
fi

stage "stage 6: optional deployed video-stream validation"
if [[ "${RUN_EMULATOR_STREAM_TEST:-0}" == "1" || -n "${E2E_BASE_URL:-}" ]]; then
  echo "[testbed] running deployed Playwright video-stream validation"
  run_npm --prefix frontend run test:e2e:guacamole-http
else
  echo "[testbed] skipping deployed video-stream validation (set RUN_EMULATOR_STREAM_TEST=1 or E2E_BASE_URL to run it)"
fi

echo "[testbed] all checks passed"
