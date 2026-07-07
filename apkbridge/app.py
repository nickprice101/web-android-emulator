from contextlib import contextmanager
import errno
import fnmatch
import json
import os
import queue
import signal
import shlex
import shutil
import subprocess
import tempfile
import uuid
import threading
import time
import zipfile
from pathlib import Path

from flask import Flask, Response, jsonify, request, stream_with_context

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows unit-test fallback
    fcntl = None

app = Flask(__name__)

ADB_TARGET = os.environ.get("ADB_TARGET", "emulator:5555")
WORKSPACE_ROOT = Path(os.environ.get("WORKSPACE_ROOT", "/workspace")).resolve()
SCREENRECORD_BIT_RATE = max(1_000_000, int(os.environ.get("SCREENRECORD_BIT_RATE", "12000000")))
SCREENRECORD_TIME_LIMIT = max(10, min(180, int(os.environ.get("SCREENRECORD_TIME_LIMIT", "180"))))
SCREENRECORD_MAX_CONSECUTIVE_FAILURES = 3
SCREENRECORD_RETRY_DELAY_SECONDS = 0.5

SCRCPY_VIDEO_BIT_RATE = max(1_000_000, int(os.environ.get("SCRCPY_VIDEO_BIT_RATE", "6000000")))
SCRCPY_MAX_SIZE = max(320, int(os.environ.get("SCRCPY_MAX_SIZE", "720")))
SCRCPY_MAX_FPS = max(1, int(os.environ.get("SCRCPY_MAX_FPS", "30")))
SCRCPY_FFMPEG_FRAGMENT_US = max(50000, int(os.environ.get("SCRCPY_FFMPEG_FRAGMENT_US", "125000")))
SCRCPY_STARTUP_TIMEOUT_SECONDS = max(1.0, float(os.environ.get("SCRCPY_STARTUP_TIMEOUT_SECONDS", "20")))
SCRCPY_LOG_CAPTURE_LIMIT = max(4096, int(os.environ.get("SCRCPY_LOG_CAPTURE_LIMIT", "65536")))
SCRCPY_PORT_RANGE = os.environ.get("SCRCPY_PORT_RANGE", "27183:27283").strip() or "27183:27283"
SCRCPY_STREAM_LOCK_WAIT_SECONDS = max(0.0, float(os.environ.get("SCRCPY_STREAM_LOCK_WAIT_SECONDS", "8")))
SCRCPY_STREAM_LOCK_RETRY_INTERVAL_SECONDS = max(
    0.05, float(os.environ.get("SCRCPY_STREAM_LOCK_RETRY_INTERVAL_SECONDS", "0.1"))
)
VIDEO_STARTUP_NUDGE_DELAY_SECONDS = max(0.0, float(os.environ.get("VIDEO_STARTUP_NUDGE_DELAY_SECONDS", "0.75")))
VIDEO_STARTUP_NUDGE_INTERVAL_SECONDS = max(0.05, float(os.environ.get("VIDEO_STARTUP_NUDGE_INTERVAL_SECONDS", "0.75")))
VIDEO_STARTUP_NUDGE_REPEATS = max(0, int(os.environ.get("VIDEO_STARTUP_NUDGE_REPEATS", "3")))
ADB_INSTALL_ABI = os.environ.get("ADB_INSTALL_ABI", "auto-ai").strip()
AI_NATIVE_LIB_PATTERNS = tuple(
    pattern.strip()
    for pattern in os.environ.get(
        "AI_NATIVE_LIB_PATTERNS",
        "libLlama-*.so,libmlc*.so,libtvm4j_runtime_packed.so",
    ).split(",")
    if pattern.strip()
)
SCRCPY_STREAM_LOCK_PATH = Path(
    os.environ.get("SCRCPY_STREAM_LOCK_PATH", str(Path(tempfile.gettempdir()) / "apkbridge-scrcpy-video.lock"))
)
SCRCPY_STREAM_STATE_PATH = Path(
    os.environ.get("SCRCPY_STREAM_STATE_PATH", str(Path(tempfile.gettempdir()) / "apkbridge-scrcpy-video.json"))
)
SCRCPY_SHUTDOWN_TIMEOUT_SECONDS = max(0.1, float(os.environ.get("SCRCPY_SHUTDOWN_TIMEOUT_SECONDS", "2")))
KEY_MAP = {"HOME": "3", "BACK": "4", "RECENTS": "187", "POWER": "26", "MENU": "82"}
KEY_NAME_MAP = {
    "GoHome": KEY_MAP["HOME"],
    "GoBack": KEY_MAP["BACK"],
    "AppSwitch": KEY_MAP["RECENTS"],
    "Power": KEY_MAP["POWER"],
    "Menu": KEY_MAP["MENU"],
    "ArrowUp": "19",
    "ArrowDown": "20",
    "ArrowLeft": "21",
    "ArrowRight": "22",
    "Enter": "66",
    "Tab": "61",
    "Space": "62",
    "Backspace": "67",
    "Delete": "112",
}
SCRCPY_STREAM_THREAD_LOCK = threading.Lock()
AUTO_INSTALL_ABI_MODES = {"", "auto", "none", "default"}
AUTO_AI_INSTALL_ABI_MODES = {"ai", "auto-ai", "prefer-ai", "mlc-ai"}


class ScrcpyStreamBusy(RuntimeError):
    """Raised when the scrcpy stream manager cannot be acquired."""


class ScrcpyStreamSuperseded(RuntimeError):
    """Raised when a newer client has replaced this scrcpy stream."""


def run(cmd, timeout=90):
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except FileNotFoundError as e:
        return 127, "", str(e)
    except subprocess.TimeoutExpired:
        return 1, "", "ADB Timeout"


def adb(*args, timeout=90):
    rc, out, err = run(["adb", "-s", ADB_TARGET, *args], timeout=timeout)
    if rc != 0:
        raise RuntimeError(err or out or "adb command failed")
    return out or err or "ok"


def run_binary(cmd, timeout=30):
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
        return proc.returncode, proc.stdout, proc.stderr
    except FileNotFoundError as e:
        return 127, b"", str(e).encode("utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        return 1, b"", b"ADB Timeout"


def adb_binary(*args, timeout=30):
    rc, out, err = run_binary(["adb", "-s", ADB_TARGET, *args], timeout=timeout)
    if rc != 0:
        raise RuntimeError((err or out or b"adb command failed").decode("utf-8", errors="replace"))
    return out


def adb_popen(*args):
    return subprocess.Popen(
        ["adb", "-s", ADB_TARGET, *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
    )


def parse_abi_list(value):
    return [part.strip() for part in str(value or "").replace(" ", ",").split(",") if part.strip()]


def adb_getprop(prop_name, timeout=8):
    rc, out, err = run(["adb", "-s", ADB_TARGET, "shell", "getprop", prop_name], timeout=timeout)
    if rc != 0:
        raise RuntimeError(err or out or f"adb getprop {prop_name} failed")
    return out.strip()


def get_device_supported_abis():
    abis = parse_abi_list(adb_getprop("ro.product.cpu.abilist"))
    if abis:
        return abis

    fallback = []
    for prop_name in ("ro.product.cpu.abi", "ro.product.cpu.abi2"):
        value = adb_getprop(prop_name)
        if value and value not in fallback:
            fallback.append(value)
    return fallback


def apk_native_libs_by_abi(apk_path):
    libs_by_abi = {}
    try:
        with zipfile.ZipFile(apk_path) as apk:
            for entry_name in apk.namelist():
                parts = entry_name.split("/")
                if len(parts) != 3 or parts[0] != "lib" or not parts[2].endswith(".so"):
                    continue
                libs_by_abi.setdefault(parts[1], set()).add(parts[2])
    except (FileNotFoundError, zipfile.BadZipFile):
        return {}

    return {abi: sorted(libs) for abi, libs in sorted(libs_by_abi.items())}


def is_ai_native_lib(lib_name):
    lowered_name = lib_name.lower()
    return any(fnmatch.fnmatchcase(lowered_name, pattern.lower()) for pattern in AI_NATIVE_LIB_PATTERNS)


def apk_ai_native_libs_by_abi(apk_path):
    return {
        abi: [lib_name for lib_name in libs if is_ai_native_lib(lib_name)]
        for abi, libs in apk_native_libs_by_abi(apk_path).items()
        if any(is_ai_native_lib(lib_name) for lib_name in libs)
    }


def resolve_adb_install_abi(apk_path):
    mode = (ADB_INSTALL_ABI or "auto-ai").strip()
    mode_key = mode.lower()
    if mode_key in AUTO_INSTALL_ABI_MODES:
        return {
            "mode": mode or "auto",
            "resolved_abi": None,
            "reason": "Android package manager ABI auto-selection requested.",
            "device_abis": [],
            "apk_ai_abis": {},
        }
    if mode_key not in AUTO_AI_INSTALL_ABI_MODES:
        return {
            "mode": mode,
            "resolved_abi": mode,
            "reason": f"Explicit install ABI requested: {mode}.",
            "device_abis": [],
            "apk_ai_abis": {},
        }

    apk_ai_abis = apk_ai_native_libs_by_abi(apk_path)
    if not apk_ai_abis:
        return {
            "mode": mode,
            "resolved_abi": None,
            "reason": (
                "No AI native libraries matched "
                f"{', '.join(AI_NATIVE_LIB_PATTERNS)}; using Android package manager ABI auto-selection."
            ),
            "device_abis": [],
            "apk_ai_abis": {},
        }

    device_abis = get_device_supported_abis()
    if not device_abis:
        raise RuntimeError("Unable to determine device ABI list for AI-aware APK install.")

    compatible = [abi for abi in device_abis if abi in apk_ai_abis]
    if not compatible:
        raise RuntimeError(
            "APK contains AI native libraries for "
            f"{', '.join(sorted(apk_ai_abis))}, but the connected device exposes "
            f"{', '.join(device_abis)}. Use an emulator image with the matching ABI/native bridge "
            "(for ARM64-only AI libraries, use the API 36 Google APIs x86_64 image) or build the APK "
            "with AI native libraries for the emulator ABI."
        )

    selected = sorted(
        compatible,
        key=lambda abi: (-len(apk_ai_abis.get(abi, [])), device_abis.index(abi)),
    )[0]
    return {
        "mode": mode,
        "resolved_abi": selected,
        "reason": (
            f"Selected {selected} because the APK includes AI native libraries "
            f"({', '.join(apk_ai_abis[selected])}) for a device-supported ABI."
        ),
        "device_abis": device_abis,
        "apk_ai_abis": apk_ai_abis,
    }


def adb_install_plan(apk_path):
    abi_plan = resolve_adb_install_abi(apk_path)
    args = ["install", "-r", "-t", "-g"]
    if abi_plan["resolved_abi"]:
        args.extend(["--abi", abi_plan["resolved_abi"]])
    args.append(str(apk_path))
    return {"args": args, **abi_plan}


def adb_install_args(apk_path):
    return adb_install_plan(apk_path)["args"]


def install_abi_response_fields(install_plan):
    return {
        "install_abi": install_plan["resolved_abi"] or "auto",
        "install_abi_mode": install_plan["mode"],
        "install_abi_reason": install_plan["reason"],
        "device_abis": install_plan["device_abis"],
        "apk_ai_abis": install_plan["apk_ai_abis"],
    }


def scrcpy_stream_lock_retry_delay(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return 0
    return min(SCRCPY_STREAM_LOCK_RETRY_INTERVAL_SECONDS, remaining)


@contextmanager
def scrcpy_stream_lock(wait_seconds=0.0):
    """Hold one live scrcpy capture across all gunicorn workers."""
    deadline = time.monotonic() + max(0.0, wait_seconds)

    if fcntl is None:
        acquired = False
        while True:
            acquired = SCRCPY_STREAM_THREAD_LOCK.acquire(blocking=False)
            if acquired:
                break
            retry_delay = scrcpy_stream_lock_retry_delay(deadline)
            if retry_delay <= 0:
                break
            time.sleep(retry_delay)
        try:
            yield acquired
        finally:
            if acquired:
                SCRCPY_STREAM_THREAD_LOCK.release()
        return

    SCRCPY_STREAM_LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    lock_file = SCRCPY_STREAM_LOCK_PATH.open("a+b")
    acquired = False
    try:
        while True:
            try:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except OSError as exc:
                if exc.errno not in (errno.EACCES, errno.EAGAIN):
                    raise
                retry_delay = scrcpy_stream_lock_retry_delay(deadline)
                if retry_delay <= 0:
                    break
                time.sleep(retry_delay)
        yield acquired
    finally:
        if acquired:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        lock_file.close()


def read_process_cmdline(pid):
    try:
        raw_cmdline = Path(f"/proc/{int(pid)}/cmdline").read_bytes()
    except (FileNotFoundError, ProcessLookupError, PermissionError, OSError, ValueError):
        return []

    return [part.decode("utf-8", errors="replace") for part in raw_cmdline.split(b"\0") if part]


def process_cmd_basename(args):
    return Path(args[0]).name if args else ""


def is_scrcpy_cmdline(args):
    if process_cmd_basename(args) != "scrcpy":
        return False
    return ADB_TARGET in args or SCRCPY_PORT_RANGE in args or "--serial" not in args


def is_ffmpeg_cmdline_for_fifo(args, fifo_path):
    return process_cmd_basename(args) == "ffmpeg" and bool(fifo_path) and str(fifo_path) in args


def process_is_zombie(pid):
    try:
        stat_text = Path(f"/proc/{int(pid)}/stat").read_text(encoding="utf-8", errors="replace")
        state = stat_text.rsplit(")", 1)[1].strip().split()[0]
        return state == "Z"
    except (FileNotFoundError, ProcessLookupError, PermissionError, OSError, IndexError, ValueError):
        return False


def process_is_running(pid):
    try:
        pid = int(pid)
        if pid <= 0:
            return False
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except (OSError, ValueError):
        return False

    return not process_is_zombie(pid)


def send_signal_to_process_or_group(pid, sig):
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False

    if pid <= 0 or pid == os.getpid():
        return False

    if os.name == "posix" and hasattr(os, "killpg"):
        try:
            os.killpg(pid, sig)
            return True
        except ProcessLookupError:
            return False
        except OSError as exc:
            if exc.errno not in (errno.ESRCH, errno.EPERM):
                app.logger.debug("failed to signal process group %s: %s", pid, exc)

    try:
        os.kill(pid, sig)
        return True
    except ProcessLookupError:
        return False
    except OSError as exc:
        if exc.errno not in (errno.ESRCH, errno.EPERM):
            app.logger.debug("failed to signal process %s: %s", pid, exc)
        return False


def terminate_pid(pid, label, cmdline_matches=None, timeout_seconds=None):
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False

    if pid <= 0 or pid == os.getpid():
        return False

    args = read_process_cmdline(pid)
    if cmdline_matches and not cmdline_matches(args):
        app.logger.debug("skipping %s pid %s because cmdline no longer matches: %s", label, pid, shlex.join(args))
        return False

    if not process_is_running(pid):
        return False

    timeout_seconds = SCRCPY_SHUTDOWN_TIMEOUT_SECONDS if timeout_seconds is None else max(0.0, timeout_seconds)
    app.logger.info("terminating previous %s pid %s", label, pid)
    send_signal_to_process_or_group(pid, signal.SIGTERM)

    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if not process_is_running(pid):
            return True
        time.sleep(0.05)

    sigkill = getattr(signal, "SIGKILL", signal.SIGTERM)
    app.logger.warning("force killing previous %s pid %s after %.1fs", label, pid, timeout_seconds)
    send_signal_to_process_or_group(pid, sigkill)
    return True


def terminate_process(proc, label):
    if not proc or proc.poll() is not None:
        return

    pid = getattr(proc, "pid", None)
    if pid:
        terminate_pid(pid, label)
    else:
        proc.terminate()

    try:
        proc.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            app.logger.warning("%s process did not exit after kill", label)


def iter_scrcpy_process_pids():
    proc_root = Path("/proc")
    if not proc_root.exists():
        return

    for proc_dir in proc_root.iterdir():
        if not proc_dir.name.isdigit():
            continue
        pid = int(proc_dir.name)
        if pid == os.getpid():
            continue
        if is_scrcpy_cmdline(read_process_cmdline(pid)):
            yield pid


def read_scrcpy_stream_state():
    try:
        state = json.loads(SCRCPY_STREAM_STATE_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as exc:
        app.logger.warning("could not read scrcpy stream state %s: %s", SCRCPY_STREAM_STATE_PATH, exc)
        return {}

    return state if isinstance(state, dict) else {}


def write_scrcpy_stream_state(owner_token, scrcpy_proc, ffmpeg_proc, fifo_path):
    SCRCPY_STREAM_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    state = {
        "owner": owner_token,
        "worker_pid": os.getpid(),
        "scrcpy_pid": getattr(scrcpy_proc, "pid", None),
        "ffmpeg_pid": getattr(ffmpeg_proc, "pid", None),
        "fifo_path": str(fifo_path),
        "started_at": time.time(),
    }
    temp_state_path = SCRCPY_STREAM_STATE_PATH.with_name(f"{SCRCPY_STREAM_STATE_PATH.name}.{owner_token}.tmp")
    temp_state_path.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")
    os.replace(temp_state_path, SCRCPY_STREAM_STATE_PATH)


def scrcpy_stream_state_matches(owner_token):
    return read_scrcpy_stream_state().get("owner") == owner_token


def clear_scrcpy_stream_state(owner_token):
    with scrcpy_stream_lock(wait_seconds=SCRCPY_STREAM_LOCK_WAIT_SECONDS) as lock_acquired:
        if not lock_acquired:
            app.logger.warning("could not acquire scrcpy stream manager lock to clear owner %s", owner_token)
            return
        if read_scrcpy_stream_state().get("owner") != owner_token:
            return
        try:
            SCRCPY_STREAM_STATE_PATH.unlink()
        except FileNotFoundError:
            pass


def shutdown_existing_scrcpy_stream():
    state = read_scrcpy_stream_state()
    fifo_path = state.get("fifo_path")
    recorded_pids = {pid for pid in (state.get("scrcpy_pid"), state.get("ffmpeg_pid")) if pid}

    if state:
        terminate_pid(state.get("scrcpy_pid"), "scrcpy", is_scrcpy_cmdline)
        terminate_pid(
            state.get("ffmpeg_pid"),
            "scrcpy ffmpeg",
            lambda args: is_ffmpeg_cmdline_for_fifo(args, fifo_path),
        )
        try:
            SCRCPY_STREAM_STATE_PATH.unlink()
        except FileNotFoundError:
            pass

    for pid in iter_scrcpy_process_pids() or []:
        if pid in recorded_pids:
            continue
        terminate_pid(pid, "untracked scrcpy", is_scrcpy_cmdline)


def fragmented_mp4_output_args():
    return [
        "-an",
        "-c:v",
        "copy",
        "-flush_packets",
        "1",
        "-muxdelay",
        "0",
        "-muxpreload",
        "0",
        "-movflags",
        "empty_moov+default_base_moof+separate_moof+omit_tfhd_offset",
        "-frag_duration",
        str(SCRCPY_FFMPEG_FRAGMENT_US),
        "-min_frag_duration",
        str(SCRCPY_FFMPEG_FRAGMENT_US),
        "-f",
        "mp4",
        "pipe:1",
    ]


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


def nudge_display_for_video_startup():
    if VIDEO_STARTUP_NUDGE_REPEATS <= 0:
        return

    try:
        adb("shell", "input", "keyevent", "224", timeout=5)
        adb("shell", "wm", "dismiss-keyguard", timeout=5)
    except Exception as exc:
        app.logger.debug("video startup wake nudge failed: %s", exc)

    for index in range(VIDEO_STARTUP_NUDGE_REPEATS):
        try:
            adb("shell", "input", "tap", "0", "0", timeout=5)
        except Exception as exc:
            app.logger.debug("video startup tap nudge failed: %s", exc)
            return
        if index + 1 < VIDEO_STARTUP_NUDGE_REPEATS:
            time.sleep(VIDEO_STARTUP_NUDGE_INTERVAL_SECONDS)


def schedule_video_startup_nudge():
    if VIDEO_STARTUP_NUDGE_REPEATS <= 0:
        return None

    def worker():
        if VIDEO_STARTUP_NUDGE_DELAY_SECONDS:
            time.sleep(VIDEO_STARTUP_NUDGE_DELAY_SECONDS)
        nudge_display_for_video_startup()

    thread = threading.Thread(target=worker, name="video-startup-nudge", daemon=True)
    thread.start()
    return thread


def launch_package(pkg):
    wake_and_unlock()
    return adb("shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1")


def get_screen_size():
    output = adb("shell", "wm", "size")
    for line in output.splitlines():
        cleaned = line.strip()
        if ":" in cleaned:
            cleaned = cleaned.split(":", 1)[1].strip()
        if "x" not in cleaned:
            continue
        left, right = cleaned.lower().split("x", 1)
        if left.isdigit() and right.isdigit():
            return {"width": int(left), "height": int(right)}
    raise RuntimeError("Unable to determine emulator screen size")


def clamp_coordinate(value, maximum):
    return max(0, min(int(round(float(value))), max(0, maximum - 1)))


def parse_number(value, field_name):
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"Input payload requires numeric {field_name}")
    if parsed != parsed or parsed in (float("inf"), float("-inf")):
        raise ValueError(f"Input payload requires finite {field_name}")
    return parsed


def coordinate_from_payload(payload, absolute_field, ratio_field, maximum):
    if payload.get(absolute_field) is not None:
        return clamp_coordinate(parse_number(payload.get(absolute_field), absolute_field), maximum)
    if payload.get(ratio_field) is not None:
        ratio = max(0.0, min(1.0, parse_number(payload.get(ratio_field), ratio_field)))
        return clamp_coordinate(ratio * max(0, maximum - 1), maximum)
    raise ValueError(f"Input payload requires {absolute_field} or {ratio_field}")


def shell_quote_text(value):
    return shlex.quote(str(value))


def execute_input_event(payload):
    event_type = str(payload.get("type", "")).strip().lower()
    if not event_type:
        raise ValueError("Input payload requires a type")

    if event_type == "key":
        key_name = str(payload.get("key", "")).strip()
        key_code = KEY_NAME_MAP.get(key_name)
        if not key_code:
            raise ValueError(f"Unsupported key '{key_name}'")
        adb("shell", "input", "keyevent", key_code)
        return {"message": f"Sent key {key_name}", "adb": ["shell", "input", "keyevent", key_code]}

    if event_type == "text":
        text = str(payload.get("text", ""))
        if not text:
            raise ValueError("Input text event requires non-empty text")
        adb("shell", f"input text {shell_quote_text(text)}")
        return {"message": "Sent text input", "adb": ["shell", "input", "text", text]}

    if event_type in {"tap", "swipe"}:
        size = get_screen_size()
        if event_type == "tap":
            x = coordinate_from_payload(payload, "x", "xRatio", size["width"])
            y = coordinate_from_payload(payload, "y", "yRatio", size["height"])
            adb("shell", "input", "tap", str(x), str(y))
            return {
                "message": f"Tapped {x},{y}",
                "adb": ["shell", "input", "tap", str(x), str(y)],
                "screen": size,
            }

        start_x = coordinate_from_payload(payload, "startX", "startXRatio", size["width"])
        start_y = coordinate_from_payload(payload, "startY", "startYRatio", size["height"])
        end_x = coordinate_from_payload(payload, "endX", "endXRatio", size["width"])
        end_y = coordinate_from_payload(payload, "endY", "endYRatio", size["height"])
        duration_ms = max(50, min(5000, int(payload.get("durationMs", 250))))
        adb(
            "shell",
            "input",
            "swipe",
            str(start_x),
            str(start_y),
            str(end_x),
            str(end_y),
            str(duration_ms),
        )
        return {
            "message": f"Swiped {start_x},{start_y} -> {end_x},{end_y}",
            "adb": [
                "shell",
                "input",
                "swipe",
                str(start_x),
                str(start_y),
                str(end_x),
                str(end_y),
                str(duration_ms),
            ],
            "screen": size,
        }

    raise ValueError(f"Unsupported input type '{event_type}'")


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


def list_installed_packages():
    lines = adb("shell", "pm", "list", "packages").splitlines()
    packages = set()
    for line in lines:
        cleaned = line.strip()
        if cleaned.startswith("package:"):
            pkg = cleaned.split("package:", 1)[1].strip()
            if pkg:
                packages.add(pkg)
    return packages


def infer_installed_package(previous_packages):
    current_packages = list_installed_packages()
    new_packages = sorted(current_packages - previous_packages)
    if new_packages:
        return new_packages[-1]
    return ""


def video_prerequisite_error():
    missing = [tool for tool in ("adb", "ffmpeg") if not shutil.which(tool)]
    if missing:
        return f"Missing required video tool(s): {', '.join(missing)}", 500

    rc, out, err = run(["adb", "-s", ADB_TARGET, "get-state"], timeout=8)
    state = (out or err).strip()
    if rc != 0 or state != "device":
        detail = state or "adb get-state did not report device"
        return f"Emulator ADB target {ADB_TARGET} is not ready: {detail}", 503

    return None


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
        before_packages = list_installed_packages()
        with tempfile.NamedTemporaryFile(suffix=".apk", delete=False) as tmp:
            f.save(tmp.name)
            tmp_path = tmp.name
        detected_pkg = detect_package_name(tmp_path)
        final_pkg = pkg or detected_pkg
        install_plan = adb_install_plan(tmp_path)
        out = adb(*install_plan["args"])
        if not final_pkg:
            final_pkg = infer_installed_package(before_packages)
        return jsonify(
            {
                "ok": True,
                "message": out,
                "package": final_pkg,
                **install_abi_response_fields(install_plan),
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
        before_packages = list_installed_packages()
        apk = safe_workspace_path(data.get("relative_path", ""))
        pkg = data.get("package", "").strip()
        detected_pkg = detect_package_name(apk)
        final_pkg = pkg or detected_pkg
        install_plan = adb_install_plan(apk)
        out = adb(*install_plan["args"])
        if not final_pkg:
            final_pkg = infer_installed_package(before_packages)
        return jsonify(
            {
                "ok": True,
                "message": out,
                "package": final_pkg,
                **install_abi_response_fields(install_plan),
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


@app.post("/input-key")
def input_key():
    data = request.get_json(force=True, silent=True) or {}
    try:
        result = execute_input_event({"type": "key", **data})
        return jsonify({"ok": True, **result})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.get("/scrcpy-video")
def scrcpy_video():
    """Stream scrcpy-captured emulator video as fragmented MP4 over plain HTTP.

    scrcpy records a low-latency Matroska stream into a FIFO while ffmpeg remuxes
    it into fragmented MP4 for browser MediaSource playback. This mirrors the
    Guacamole deployment shape: the server stays close to the emulator, while the
    browser only needs an ordinary proxied HTTPS response plus HTTP input calls.
    """
    bit_rate = request.args.get("bit_rate", str(SCRCPY_VIDEO_BIT_RATE)).strip()
    max_size = request.args.get("max_size", str(SCRCPY_MAX_SIZE)).strip()
    max_fps = request.args.get("max_fps", str(SCRCPY_MAX_FPS)).strip()

    try:
        bit_rate_value = max(1_000_000, int(bit_rate))
        max_size_value = max(320, int(max_size))
        max_fps_value = max(1, min(60, int(max_fps)))
    except ValueError:
        return jsonify({"ok": False, "error": "bit_rate, max_size, and max_fps must be integers"}), 400

    prerequisite_error = video_prerequisite_error()
    if prerequisite_error:
        message, status_code = prerequisite_error
        return jsonify({"ok": False, "error": message}), status_code

    def generate_scrcpy_mp4():
        fifo_path = Path(tempfile.gettempdir()) / f"scrcpy-video-{uuid.uuid4().hex}.mkv"
        scrcpy_proc = None
        ffmpeg_proc = None
        stream_queue = queue.Queue()
        stderr_chunks = []
        owner_token = uuid.uuid4().hex
        state_registered = False

        def append_stderr(chunk):
            if not chunk:
                return
            captured = sum(len(item) for item in stderr_chunks)
            remaining = SCRCPY_LOG_CAPTURE_LIMIT - captured
            if remaining > 0:
                stderr_chunks.append(chunk[:remaining])

        def collected_stderr():
            return b"".join(stderr_chunks).decode("utf-8", errors="replace").strip()

        def fail_stream(reason):
            stderr_text = collected_stderr()
            message = f"{reason}: {stderr_text}" if stderr_text else reason
            app.logger.error("scrcpy video stream failed: %s", message)
            raise RuntimeError(message)

        def drain_pending_stderr():
            while True:
                try:
                    stream_name, chunk = stream_queue.get_nowait()
                except queue.Empty:
                    break
                if stream_name != "ffmpeg-stdout":
                    append_stderr(chunk)

        def pump_pipe(fileobj, stream_name, chunk_size=32 * 1024):
            try:
                while fileobj:
                    chunk = fileobj.read(chunk_size)
                    stream_queue.put((stream_name, chunk or b""))
                    if not chunk:
                        break
            except Exception as exc:
                stream_queue.put((f"{stream_name}:error", str(exc).encode("utf-8", errors="replace")))

        def fail_if_superseded():
            if not scrcpy_stream_state_matches(owner_token):
                raise ScrcpyStreamSuperseded("scrcpy video stream was replaced by a newer client")

        if not shutil.which("scrcpy"):
            fail_stream("scrcpy binary is not available")

        try:
            os.mkfifo(fifo_path, 0o600)
            scrcpy_cmd = [
                "scrcpy",
                "--serial",
                ADB_TARGET,
                "--no-window",
                "--no-control",
                "--no-audio",
                "--port",
                SCRCPY_PORT_RANGE,
                "--video-codec",
                "h264",
                "--video-bit-rate",
                str(bit_rate_value),
                "--max-size",
                str(max_size_value),
                "--max-fps",
                str(max_fps_value),
                "--record",
                str(fifo_path),
                "--record-format",
                "mkv",
            ]
            ffmpeg_cmd = [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "warning",
                "-fflags",
                "+genpts",
                "-flags",
                "low_delay",
                "-f",
                "matroska",
                "-probesize",
                "65536",
                "-analyzeduration",
                "1000000",
                "-i",
                str(fifo_path),
                *fragmented_mp4_output_args(),
            ]

            with scrcpy_stream_lock(wait_seconds=SCRCPY_STREAM_LOCK_WAIT_SECONDS) as lock_acquired:
                if not lock_acquired:
                    raise ScrcpyStreamBusy("timed out waiting for the scrcpy stream manager lock")

                shutdown_existing_scrcpy_stream()
                ffmpeg_proc = subprocess.Popen(
                    ffmpeg_cmd,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    bufsize=0,
                    start_new_session=True,
                )
                scrcpy_proc = subprocess.Popen(
                    scrcpy_cmd,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    stdin=subprocess.DEVNULL,
                    bufsize=0,
                    start_new_session=True,
                )
                write_scrcpy_stream_state(owner_token, scrcpy_proc, ffmpeg_proc, fifo_path)
                state_registered = True

            schedule_video_startup_nudge()

            threading.Thread(target=pump_pipe, args=(ffmpeg_proc.stdout, "ffmpeg-stdout"), daemon=True).start()
            threading.Thread(target=pump_pipe, args=(ffmpeg_proc.stderr, "ffmpeg-stderr"), daemon=True).start()
            threading.Thread(target=pump_pipe, args=(scrcpy_proc.stderr, "scrcpy-stderr"), daemon=True).start()

            delivered = False
            startup_deadline = time.monotonic() + SCRCPY_STARTUP_TIMEOUT_SECONDS
            while True:
                try:
                    stream_name, chunk = stream_queue.get(timeout=0.25)
                except queue.Empty:
                    fail_if_superseded()
                    if ffmpeg_proc.poll() is not None:
                        break
                    if not delivered and scrcpy_proc.poll() is not None:
                        drain_pending_stderr()
                        fail_if_superseded()
                        fail_stream("scrcpy exited before producing video")
                    if not delivered and time.monotonic() >= startup_deadline:
                        drain_pending_stderr()
                        fail_if_superseded()
                        fail_stream(f"timed out waiting {SCRCPY_STARTUP_TIMEOUT_SECONDS:g}s for scrcpy video")
                    continue

                if stream_name == "ffmpeg-stdout":
                    if not chunk:
                        fail_if_superseded()
                        if not delivered and scrcpy_proc.poll() is not None:
                            drain_pending_stderr()
                            fail_stream("scrcpy exited before producing video")
                        if ffmpeg_proc.poll() is not None:
                            break
                        continue

                    fail_if_superseded()
                    delivered = True
                    yield chunk
                    continue

                append_stderr(chunk)

            if not delivered:
                fail_if_superseded()
                fail_stream("scrcpy video stream ended before producing video")

            stderr_text = collected_stderr()
            if stderr_text:
                app.logger.warning(
                    "scrcpy video stream ended: %s",
                    stderr_text,
                )
        finally:
            terminate_process(scrcpy_proc, "scrcpy")
            terminate_process(ffmpeg_proc, "scrcpy ffmpeg")
            if state_registered:
                clear_scrcpy_stream_state(owner_token)
            try:
                fifo_path.unlink()
            except FileNotFoundError:
                pass

    def generate_screenrecord_mp4(fallback_reason):
        app.logger.warning("Using adb screenrecord MP4 fallback for /scrcpy-video: %s", fallback_reason)
        consecutive_failures = 0

        while consecutive_failures < SCREENRECORD_MAX_CONSECUTIVE_FAILURES:
            screenrecord_proc = None
            ffmpeg_proc = None
            stream_queue = queue.Queue()
            stderr_chunks = []

            def append_stderr(chunk):
                if not chunk:
                    return
                captured = sum(len(item) for item in stderr_chunks)
                remaining = SCRCPY_LOG_CAPTURE_LIMIT - captured
                if remaining > 0:
                    stderr_chunks.append(chunk[:remaining])

            def collected_stderr():
                return b"".join(stderr_chunks).decode("utf-8", errors="replace").strip()

            def pump_pipe(fileobj, stream_name, chunk_size=32 * 1024):
                try:
                    while fileobj:
                        chunk = fileobj.read(chunk_size)
                        stream_queue.put((stream_name, chunk or b""))
                        if not chunk:
                            break
                except Exception as exc:
                    stream_queue.put((f"{stream_name}:error", str(exc).encode("utf-8", errors="replace")))

            try:
                screenrecord_proc = adb_popen(
                    "exec-out",
                    "screenrecord",
                    "--bugreport",
                    "--output-format=h264",
                    "--bit-rate",
                    str(bit_rate_value),
                    "--time-limit",
                    str(SCREENRECORD_TIME_LIMIT),
                    "-",
                )
                ffmpeg_cmd = [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "warning",
                    "-fflags",
                    "+genpts",
                    "-flags",
                    "low_delay",
                    "-probesize",
                    "65536",
                    "-analyzeduration",
                    "1000000",
                    "-f",
                    "h264",
                    "-i",
                    "pipe:0",
                    *fragmented_mp4_output_args(),
                ]
                ffmpeg_proc = subprocess.Popen(
                    ffmpeg_cmd,
                    stdin=screenrecord_proc.stdout,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    bufsize=0,
                )
                if screenrecord_proc.stdout:
                    screenrecord_proc.stdout.close()

                schedule_video_startup_nudge()

                open_streams = 0
                for fileobj, stream_name in (
                    (ffmpeg_proc.stdout, "ffmpeg-stdout"),
                    (ffmpeg_proc.stderr, "ffmpeg-stderr"),
                    (screenrecord_proc.stderr, "screenrecord-stderr"),
                ):
                    if fileobj:
                        open_streams += 1
                        threading.Thread(target=pump_pipe, args=(fileobj, stream_name), daemon=True).start()

                delivered = False
                startup_deadline = time.monotonic() + SCRCPY_STARTUP_TIMEOUT_SECONDS
                while open_streams > 0:
                    try:
                        stream_name, chunk = stream_queue.get(timeout=0.25)
                    except queue.Empty:
                        if ffmpeg_proc.poll() is not None:
                            break
                        if not delivered and time.monotonic() >= startup_deadline:
                            break
                        continue

                    if not chunk:
                        open_streams -= 1
                        continue

                    if stream_name == "ffmpeg-stdout":
                        delivered = True
                        consecutive_failures = 0
                        yield chunk
                    else:
                        append_stderr(chunk)

                if delivered:
                    continue

                consecutive_failures += 1
                stderr_text = collected_stderr()
                app.logger.warning(
                    "adb screenrecord MP4 fallback produced no video (%s/%s): %s",
                    consecutive_failures,
                    SCREENRECORD_MAX_CONSECUTIVE_FAILURES,
                    stderr_text or "no stderr",
                )
                if consecutive_failures < SCREENRECORD_MAX_CONSECUTIVE_FAILURES:
                    time.sleep(SCREENRECORD_RETRY_DELAY_SECONDS)
            finally:
                for proc in (screenrecord_proc, ffmpeg_proc):
                    if proc and proc.poll() is None:
                        proc.terminate()
                        try:
                            proc.wait(timeout=2)
                        except subprocess.TimeoutExpired:
                            proc.kill()
                if screenrecord_proc and screenrecord_proc.stderr:
                    screenrecord_proc.stderr.close()
                if ffmpeg_proc and ffmpeg_proc.stdout:
                    ffmpeg_proc.stdout.close()
                if ffmpeg_proc and ffmpeg_proc.stderr:
                    ffmpeg_proc.stderr.close()

        raise RuntimeError(f"scrcpy failed and adb screenrecord fallback produced no video: {fallback_reason}")

    def generate_with_fallback():
        try:
            yield from generate_scrcpy_mp4()
        except ScrcpyStreamSuperseded:
            app.logger.info("scrcpy video stream ended because a newer request replaced it")
            return
        except ScrcpyStreamBusy:
            raise
        except RuntimeError as exc:
            yield from generate_screenrecord_mp4(str(exc))

    stream = generate_with_fallback()
    try:
        first_chunk = next(stream)
    except StopIteration:
        return jsonify({"ok": False, "error": "scrcpy video stream ended before producing video"}), 503
    except ScrcpyStreamBusy as e:
        return jsonify({"ok": False, "error": str(e)}), 503
    except ScrcpyStreamSuperseded as e:
        return jsonify({"ok": False, "error": str(e)}), 409
    except RuntimeError as e:
        return jsonify({"ok": False, "error": str(e)}), 503
    except Exception as e:
        app.logger.exception("scrcpy video stream failed before headers")
        return jsonify({"ok": False, "error": str(e)}), 500

    def generate_with_first_chunk():
        try:
            yield first_chunk
            yield from stream
        finally:
            stream.close()

    return Response(
        stream_with_context(generate_with_first_chunk()),
        mimetype='video/mp4; codecs="avc1.42E01E"',
        headers={
            "Cache-Control": "no-store, no-transform",
            "X-Accel-Buffering": "no",
        },
        direct_passthrough=True,
    )


@app.post("/input-event")
def input_event():
    data = request.get_json(force=True, silent=True) or {}
    try:
        result = execute_input_event(data)
        return jsonify({"ok": True, **result})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.get("/frame")
def frame():
    try:
        png = adb_binary("exec-out", "screencap", "-p", timeout=20)
        return Response(png, mimetype="image/png")
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/screenrecord")
def screenrecord():
    bit_rate = request.args.get("bit_rate", str(SCREENRECORD_BIT_RATE)).strip()
    time_limit = request.args.get("time_limit", str(SCREENRECORD_TIME_LIMIT)).strip()

    try:
        bit_rate_value = max(1_000_000, int(bit_rate))
        time_limit_value = max(10, min(180, int(time_limit)))
    except ValueError:
        return jsonify({"ok": False, "error": "bit_rate and time_limit must be integers"}), 400

    def generate():
        # Loop screenrecord segments so the HTTP response stays open indefinitely.
        # Each segment runs for up to time_limit_value seconds (max 180 s, the
        # Android hard limit).  When one segment ends we immediately start the next
        # one, keeping the byte stream continuous from the bridge's perspective.
        # The brief pause (~3-7 s for MediaCodec re-init) during the restart
        # appears as a momentary video freeze rather than a session reconnection.
        consecutive_failures = 0
        while consecutive_failures < SCREENRECORD_MAX_CONSECUTIVE_FAILURES:
            proc = adb_popen(
                "exec-out",
                "screenrecord",
                "--output-format=h264",
                "--bit-rate",
                str(bit_rate_value),
                "--time-limit",
                str(time_limit_value),
                "-",
            )
            delivered = False
            stderr_chunks = []
            stream_queue = queue.Queue()

            def pump_stream(fileobj, stream_name):
                try:
                    while True:
                        chunk = os.read(fileobj.fileno(), 64 * 1024)
                        stream_queue.put((stream_name, chunk))
                        if not chunk:
                            break
                finally:
                    fileobj.close()

            if proc.stdout:
                threading.Thread(
                    target=pump_stream,
                    args=(proc.stdout, "stdout"),
                    daemon=True,
                ).start()
            if proc.stderr:
                threading.Thread(
                    target=pump_stream,
                    args=(proc.stderr, "stderr"),
                    daemon=True,
                ).start()

            open_streams = sum(1 for stream in (proc.stdout, proc.stderr) if stream)
            try:
                while open_streams > 0:
                    try:
                        stream_name, chunk = stream_queue.get(timeout=1)
                    except queue.Empty:
                        if proc.poll() is not None:
                            break
                        continue

                    if not chunk:
                        open_streams -= 1
                        continue

                    if stream_name == "stdout":
                        delivered = True
                        consecutive_failures = 0
                        yield chunk
                    else:
                        stderr_chunks.append(chunk)
            finally:
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                if proc.stdout:
                    proc.stdout.close()
                if proc.stderr:
                    proc.stderr.close()

            if not delivered:
                # screenrecord exited immediately without producing any data;
                # treat as a transient error and back off briefly before retrying.
                consecutive_failures += 1
                stderr_text = b"".join(stderr_chunks).decode("utf-8", errors="replace").strip()
                if stderr_text:
                    app.logger.warning("screenrecord exited without data: %s", stderr_text)
                time.sleep(SCREENRECORD_RETRY_DELAY_SECONDS)
            # Normal exit (time limit reached): loop immediately.

    return Response(
        stream_with_context(generate()),
        mimetype="video/h264",
        headers={"Cache-Control": "no-store"},
        direct_passthrough=True,
    )


@app.get("/device-info")
def device_info():
    try:
        size = get_screen_size()
        abi_error = None
        try:
            abis = get_device_supported_abis()
        except Exception as exc:
            abis = []
            abi_error = str(exc)
        payload = {"ok": True, "screen": size, "target": ADB_TARGET, "abis": abis}
        if abi_error:
            payload["abi_error"] = abi_error
        return jsonify(payload)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


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
    fatal_only = request.args.get("fatal_only", "0") in {"1", "true", "yes", "on"}

    try:
        capture_count = min(2000, max(limit * 5, 200))
        logcat_args = ["logcat", "-d", "-t", str(capture_count), "-v", "time"]
        if errors_only:
            logcat_args.extend(["*:E"])

        combined_lines = [line for line in adb(*logcat_args, timeout=20).splitlines() if line.strip()]

        # The crash buffer keeps Java/Kotlin fatal exception stacks even when
        # the main buffer is noisy and the interesting lines scroll out.
        if include_crash:
            crash_lines = [
                line
                for line in adb(
                    "logcat",
                    "-d",
                    "-t",
                    str(capture_count),
                    "-b",
                    "crash",
                    "-v",
                    "time",
                    timeout=20,
                ).splitlines()
                if line.strip()
            ]
            if crash_lines:
                combined_lines.append("--------- crash buffer ---------")
                combined_lines.extend(crash_lines)

        if fatal_only:
            fatal_timestamps = set()
            for line in combined_lines:
                if "FATAL EXCEPTION" in line:
                    fatal_timestamps.add(line[:18])

            if fatal_timestamps:
                combined_lines = [line for line in combined_lines if line[:18] in fatal_timestamps]
            else:
                combined_lines = []

        if text_filter:
            combined_lines = [line for line in combined_lines if text_filter in line.lower()]

        return jsonify({"ok": True, "entries": combined_lines[-limit:]})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
