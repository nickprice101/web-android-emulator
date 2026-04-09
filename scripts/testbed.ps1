#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:npm_config_cache = Join-Path $root ".npm-cache-testbed"
$env:PIP_CACHE_DIR = Join-Path $root ".pip-cache-testbed"

function Assert-LastExitCode([string]$stepName) {
  if ($LASTEXITCODE -ne 0) {
    throw "$stepName failed with exit code $LASTEXITCODE"
  }
}

function Get-TestbedPythonCommand {
  if (Get-Command python -ErrorAction SilentlyContinue) {
    return "python"
  }
  if (Get-Command py -ErrorAction SilentlyContinue) {
    return "py -3.11"
  }
  throw "No Python launcher is available for the testbed."
}

$pythonCommand = Get-TestbedPythonCommand

Write-Host "[testbed] preparing Node dependencies"
npm --prefix frontend ci
Assert-LastExitCode "npm --prefix frontend ci"
npm --prefix bridge-webrtc ci
Assert-LastExitCode "npm --prefix bridge-webrtc ci"

Write-Host "[testbed] preparing Python virtual environment"
$venvReady = $false
try {
  Invoke-Expression "$pythonCommand -m venv .venv-testbed"
  Assert-LastExitCode "$pythonCommand -m venv .venv-testbed"
  . .\.venv-testbed\Scripts\Activate.ps1
  python -m pip install --upgrade pip | Out-Null
  Assert-LastExitCode "python -m pip install --upgrade pip"
  python -m pip install -r apkbridge/requirements.txt | Out-Null
  Assert-LastExitCode "python -m pip install -r apkbridge/requirements.txt"
  $venvReady = $true
} catch {
  Write-Host "[testbed] python venv unavailable, falling back to workspace-local site-packages"
}

if (-not $venvReady) {
  $sitePackages = Join-Path $root ".venv-testbed-site"
  New-Item -ItemType Directory -Force -Path $sitePackages | Out-Null
  Invoke-Expression "$pythonCommand -m pip install -r apkbridge/requirements.txt --target `"$sitePackages`"" | Out-Null
  Assert-LastExitCode "$pythonCommand -m pip install -r apkbridge/requirements.txt --target $sitePackages"
  if ($env:PYTHONPATH) {
    $env:PYTHONPATH = "$sitePackages;$env:PYTHONPATH"
  } else {
    $env:PYTHONPATH = $sitePackages
  }
}

Write-Host "[testbed] running apkbridge unit tests"
python -m unittest discover -s apkbridge/tests -v
Assert-LastExitCode "python -m unittest discover -s apkbridge/tests -v"

Write-Host "[testbed] running bridge-webrtc unit tests"
node --test --test-force-exit bridge-webrtc/test/*.test.mjs
Assert-LastExitCode "node --test --test-force-exit bridge-webrtc/test/*.test.mjs"

Write-Host "[testbed] running native WebRTC configuration checks"
node scripts/test-native-webrtc.mjs
Assert-LastExitCode "node scripts/test-native-webrtc.mjs"

Write-Host "[testbed] running frontend build"
npm --prefix frontend run build
Assert-LastExitCode "npm --prefix frontend run build"

Write-Host "[testbed] all checks passed"
