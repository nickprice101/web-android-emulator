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


def detect_package_name(apk_path):
    apk = str(apk_path)
    probes = [
        (["aapt", "dump", "badging", apk], "badging"),
        (["apkanalyzer", "manifest", "application-id", apk], "plain"),
    ]

    for cmd, mode in probes:
        rc, out, err = run(cmd)
        if rc != 0:
            continue

        text = out.strip() or err.strip()
        if not text:
            continue

        if mode == "badging":
            for line in text.splitlines():
                line = line.strip()
                if not line.startswith("package:"):
                    continue
                marker = "name='"
                idx = line.find(marker)
                if idx == -1:
                    continue
                start = idx + len(marker)
                end = line.find("'", start)
                if end > start:
                    return line[start:end]
        else:
            pkg = text.splitlines()[0].strip()
            if pkg:
                return pkg

    return ""


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


@app.get("/apk-package")
def apk_package():
    rel = request.args.get("path", "").strip()
    if not rel:
        return jsonify({"error": "Missing apk path"}), 400
    try:
        apk = safe_workspace_path(rel)
        if apk.suffix.lower() != ".apk" or not apk.is_file():
            return jsonify({"error": "Invalid APK path"}), 400
        package = detect_package_name(apk)
        return jsonify({"ok": True, "package": package})
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
        detected_pkg = detect_package_name(tmp_path)
        final_pkg = pkg or detected_pkg
        out = adb("install", "-r", "-t", "-g", tmp_path)
        return jsonify(
            {
                "ok": True,
                "message": out,
                "package": final_pkg,
                "launch": launch_package(final_pkg) if final_pkg else None,
            }
        )
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
        detected_pkg = detect_package_name(apk)
        final_pkg = pkg or detected_pkg
        out = adb("install", "-r", "-t", "-g", str(apk))
        return jsonify(
            {
                "ok": True,
                "message": out,
                "package": final_pkg,
                "launch": launch_package(final_pkg) if final_pkg else None,
            }
        )
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


@app.get("/logcat")
def logcat():
    try:
        limit = max(1, min(500, int(request.args.get("limit", "100"))))
    except ValueError:
        limit = 100

    text_filter = request.args.get("filter", "").strip().lower()
    errors_only = request.args.get("errors_only", "0") in {"1", "true", "yes", "on"}
    include_crash = request.args.get("include_crash", "1") in {"1", "true", "yes", "on"}

    try:
        logcat_args = ["logcat", "-d", "-v", "time"]
        if errors_only:
            logcat_args.extend(["*:E"])

        combined_lines = [line for line in adb(*logcat_args).splitlines() if line.strip()]

        # The crash buffer keeps Java/Kotlin fatal exception stacks even when
        # the main buffer is noisy and the interesting lines scroll out.
        if include_crash:
            crash_lines = [line for line in adb("logcat", "-d", "-b", "crash", "-v", "time").splitlines() if line.strip()]
            if crash_lines:
                combined_lines.append("--------- crash buffer ---------")
                combined_lines.extend(crash_lines)

        if text_filter:
            combined_lines = [line for line in combined_lines if text_filter in line.lower()]

        return jsonify({"ok": True, "entries": combined_lines[-limit:]})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
