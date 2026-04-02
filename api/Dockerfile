FROM python:3.11-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends adb ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/apkbridge
ENV PYTHONPATH=/opt/apkbridge

RUN pip install --no-cache-dir flask==3.0.3 gunicorn==22.0.0

RUN printf '%s\n' \
'import os, subprocess, tempfile' \
'from pathlib import Path' \
'from flask import Flask, jsonify, request' \
'' \
'app = Flask(__name__)' \
'ADB_TARGET = os.environ.get("ADB_TARGET", "emulator:5555")' \
'WORKSPACE_ROOT = Path(os.environ.get("WORKSPACE_ROOT", "/workspace")).resolve()' \
'DEFAULT_PACKAGE = os.environ.get("DEFAULT_PACKAGE", "").strip()' \
'KEY_MAP = {"HOME": "3", "BACK": "4", "RECENTS": "187", "POWER": "26", "MENU": "82"}' \
'' \
'def run(cmd, timeout=90):' \
'    try:' \
'        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)' \
'        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()' \
'    except subprocess.TimeoutExpired: return 1, "", "ADB Timeout"' \
'' \
'def adb(*args):' \
'    rc, out, err = run(["adb", "-s", ADB_TARGET, *args])' \
'    if rc != 0:' \
'        raise RuntimeError(err or out or "adb command failed")' \
'    return out or err or "ok"' \
'' \
'def safe_workspace_path(rel):' \
'    c = (WORKSPACE_ROOT / rel).resolve()' \
'    if WORKSPACE_ROOT not in c.parents and c != WORKSPACE_ROOT: raise ValueError("Path Escape")' \
'    return c' \
'' \
'def wake_and_unlock():' \
'    try:' \
'        adb("shell", "svc", "power", "stayon", "true")' \
'        adb("shell", "input", "keyevent", KEY_MAP["MENU"])' \
'        adb("shell", "wm", "dismiss-keyguard")' \
'    except: pass' \
'' \
'def launch_package(pkg):' \
'    wake_and_unlock()' \
'    return adb("shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1")' \
'' \
'@app.get("/")' \
'def root(): return jsonify({"ok": True})' \
'' \
'@app.get("/health")' \
'def health():' \
'    try: return jsonify({"ok": "device" in adb("devices"), "target": ADB_TARGET})' \
'    except Exception as e: return jsonify({"ok": False, "error": str(e)}), 500' \
'' \
'@app.get("/browse-apks")' \
'def browse_apks():' \
'    p = request.args.get("path", "").strip()' \
'    try:' \
'        base = safe_workspace_path(p) if p else WORKSPACE_ROOT' \
'        dirs = [{"name": x.name, "path": str(x.relative_to(WORKSPACE_ROOT))} for x in sorted(base.iterdir()) if x.is_dir()]' \
'        apks = [{"name": x.name, "path": str(x.relative_to(WORKSPACE_ROOT))} for x in sorted(base.iterdir()) if x.suffix.lower() == ".apk"]' \
'        return jsonify({"ok": True, "cwd": str(base.relative_to(WORKSPACE_ROOT)), "directories": dirs, "apks": apks})' \
'    except Exception as e: return jsonify({"error": str(e)}), 400' \
'' \
'@app.post("/install-built")' \
'def install_built():' \
'    data = request.get_json(force=True, silent=True) or {}' \
'    try:' \
'        apk = safe_workspace_path(data.get("relative_path", ""))' \
'        pkg = data.get("package", "").strip()' \
'        out = adb("install", "-r", "-t", "-g", str(apk))' \
'        return jsonify({"ok": True, "message": out, "launch": launch_package(pkg) if pkg else None})' \
'    except Exception as e: return jsonify({"ok": False, "error": str(e)}), 500' \
'' \
'@app.post("/launch-default")' \
'def launch_default():' \
'    if not DEFAULT_PACKAGE: return jsonify({"error": "No default"}), 400' \
'    try: return jsonify({"ok": True, "message": launch_package(DEFAULT_PACKAGE)})' \
'    except Exception as e: return jsonify({"error": str(e)}), 500' \
> /opt/apkbridge/serverapp.py

CMD ["gunicorn", "--chdir", "/opt/apkbridge", "-b", "0.0.0.0:5000", "serverapp:app"]
