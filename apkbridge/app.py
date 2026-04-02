import os
import subprocess
import tempfile
from pathlib import Path

from flask import Flask, jsonify, request

app = Flask(__name__)

ADB_TARGET = os.environ.get("ADB_TARGET", "emulator:5555")
WORKSPACE_ROOT = Path(os.environ.get("WORKSPACE_ROOT", "/workspace")).resolve()
KEY_MAP = {"HOME": "3", "BACK": "4", "RECENTS": "187", "POWER": "26", "MENU": "82"}


def run(cmd, timeout=90):
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except subprocess.TimeoutExpired:
        return 1, "", "ADB Timeout"


def adb(*args):
    rc, out, err = run(["adb", "-s", ADB_TARGET, *args])
    if rc != 0:
        raise RuntimeError(err or out or "adb command failed")
    return out or err or "ok"


def safe_workspace_path(rel):
    # Reject absolute paths and directory-traversal components before resolving
    parts = Path(rel).parts
    if os.path.isabs(rel) or ".." in parts:
        raise ValueError("Invalid path: must be a relative path with no '..' components")
    c = (WORKSPACE_ROOT / rel).resolve()
    if WORKSPACE_ROOT not in c.parents and c != WORKSPACE_ROOT:
        raise ValueError(f"Path '{rel}' resolves outside workspace '{WORKSPACE_ROOT}'")
    return c


def wake_and_unlock():
    try:
        adb("shell", "svc", "power", "stayon", "true")
        adb("shell", "input", "keyevent", KEY_MAP["MENU"])
        adb("shell", "wm", "dismiss-keyguard")
    except Exception:
        pass


def launch_package(pkg):
    wake_and_unlock()
    return adb("shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1")


@app.get("/health")
def health():
    try:
        return jsonify({"ok": "device" in adb("devices"), "target": ADB_TARGET})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/browse-apks")
def browse_apks():
    p = request.args.get("path", "").strip()
    try:
        base = safe_workspace_path(p) if p else WORKSPACE_ROOT
        cwd = "" if base == WORKSPACE_ROOT else str(base.relative_to(WORKSPACE_ROOT))
        parent = (
            None
            if base == WORKSPACE_ROOT
            else ("" if base.parent == WORKSPACE_ROOT else str(base.parent.relative_to(WORKSPACE_ROOT)))
        )
        entries = sorted(base.iterdir())
        dirs = [{"name": x.name, "path": str(x.relative_to(WORKSPACE_ROOT))} for x in entries if x.is_dir()]
        apks = [{"name": x.name, "path": str(x.relative_to(WORKSPACE_ROOT))} for x in entries if x.suffix.lower() == ".apk"]
        return jsonify({"ok": True, "cwd": cwd, "parent": parent, "directories": dirs, "apks": apks})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.post("/install")
def install():
    if "apk" not in request.files:
        return jsonify({"error": "No APK file provided"}), 400
    f = request.files["apk"]
    pkg = request.form.get("package", "").strip()
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".apk", delete=False) as tmp:
            f.save(tmp.name)
            tmp_path = tmp.name
        out = adb("install", "-r", "-t", "-g", tmp_path)
        return jsonify({"ok": True, "message": out, "launch": launch_package(pkg) if pkg else None})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


@app.post("/install-built")
def install_built():
    data = request.get_json(force=True, silent=True) or {}
    try:
        apk = safe_workspace_path(data.get("relative_path", ""))
        pkg = data.get("package", "").strip()
        out = adb("install", "-r", "-t", "-g", str(apk))
        return jsonify({"ok": True, "message": out, "launch": launch_package(pkg) if pkg else None})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/launch")
def launch():
    data = request.get_json(force=True, silent=True) or {}
    pkg = data.get("package", "").strip()
    if not pkg:
        return jsonify({"error": "No package specified"}), 400
    try:
        return jsonify({"ok": True, "message": launch_package(pkg)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/wake")
def wake():
    try:
        wake_and_unlock()
        return jsonify({"ok": True, "message": "Device woken"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/reboot")
def reboot():
    try:
        out = adb("reboot")
        return jsonify({"ok": True, "message": out or "Rebooting..."})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
