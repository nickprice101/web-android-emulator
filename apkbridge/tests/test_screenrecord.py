import io
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app as app_module  # noqa: E402
from app import app  # noqa: E402


def make_python_proc(code):
    return subprocess.Popen(
        [sys.executable, "-c", code],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
    )


class InstallAbiTests(unittest.TestCase):
    def test_adb_install_args_include_configured_arm64_abi(self):
        with patch.object(app_module, "ADB_INSTALL_ABI", "arm64-v8a"):
            args = app_module.adb_install_args("/tmp/app.apk")

        self.assertEqual(args, ["install", "-r", "-t", "-g", "--abi", "arm64-v8a", "/tmp/app.apk"])

    def test_adb_install_args_can_use_android_default_abi_selection(self):
        with patch.object(app_module, "ADB_INSTALL_ABI", "auto"):
            args = app_module.adb_install_args("/tmp/app.apk")

        self.assertEqual(args, ["install", "-r", "-t", "-g", "/tmp/app.apk"])


class InputEventEndpointTests(unittest.TestCase):
    def test_input_event_accepts_tap_ratios_from_http_video_surface(self):
        adb_calls = []

        def fake_adb(*args, **kwargs):
            adb_calls.append(args)
            return "ok"

        client = app.test_client()
        with patch("app.get_screen_size", return_value={"width": 1080, "height": 1920}), patch(
            "app.adb", side_effect=fake_adb
        ):
            response = client.post("/input-event", json={"type": "tap", "xRatio": 0.5, "yRatio": 0.5})

        self.assertEqual(response.status_code, 200)
        self.assertIn(("shell", "input", "tap", "540", "960"), adb_calls)

    def test_input_event_accepts_swipe_ratios_from_http_video_surface(self):
        adb_calls = []

        def fake_adb(*args, **kwargs):
            adb_calls.append(args)
            return "ok"

        client = app.test_client()
        with patch("app.get_screen_size", return_value={"width": 1080, "height": 1920}), patch(
            "app.adb", side_effect=fake_adb
        ):
            response = client.post(
                "/input-event",
                json={
                    "type": "swipe",
                    "startXRatio": 0.25,
                    "startYRatio": 0.25,
                    "endXRatio": 0.75,
                    "endYRatio": 0.75,
                    "durationMs": 180,
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertIn(("shell", "input", "swipe", "270", "480", "809", "1439", "180"), adb_calls)

    def test_input_event_rejects_missing_tap_coordinates_as_bad_request(self):
        client = app.test_client()
        with patch("app.get_screen_size", return_value={"width": 1080, "height": 1920}), patch("app.adb") as adb_mock:
            response = client.post("/input-event", json={"type": "tap"})

        self.assertEqual(response.status_code, 400)
        self.assertIn("x or xRatio", response.get_json()["error"])
        adb_mock.assert_not_called()


class ScreenrecordEndpointTests(unittest.TestCase):
    def test_screenrecord_streams_first_chunk_without_waiting_for_large_buffer(self):
        code = (
            "import sys,time;"
            "sys.stdout.buffer.write(b'frame-1');"
            "sys.stdout.flush();"
            "time.sleep(0.2)"
        )
        client = app.test_client()

        with patch("app.adb_popen", side_effect=lambda *args: make_python_proc(code)):
            started_at = time.monotonic()
            response = client.get("/screenrecord?bit_rate=1000000&time_limit=10", buffered=False)
            first_chunk = next(response.response)
            elapsed = time.monotonic() - started_at

        self.assertEqual(response.status_code, 200)
        self.assertEqual(first_chunk, b"frame-1")
        self.assertLess(elapsed, 1.0)

    def test_screenrecord_retries_after_empty_attempt_and_recovers(self):
        attempts = iter(
            [
                make_python_proc("import sys; sys.stderr.write('encoder warming up\\n')"),
                make_python_proc(
                    "import sys,time;"
                    "sys.stdout.buffer.write(b'frame-2');"
                    "sys.stdout.flush();"
                    "time.sleep(0.2)"
                ),
            ]
        )
        client = app.test_client()

        with patch("app.adb_popen", side_effect=lambda *args: next(attempts)):
            response = client.get("/screenrecord?bit_rate=1000000&time_limit=10", buffered=False)
            first_chunk = next(response.response)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(first_chunk, b"frame-2")


class ScrcpyStreamLockTests(unittest.TestCase):
    class FakeFcntl:
        LOCK_EX = 1
        LOCK_NB = 2
        LOCK_UN = 4

        def __init__(self, busy_attempts):
            self.busy_attempts = busy_attempts
            self.lock_attempts = 0
            self.unlocked = False

        def flock(self, fileno, flags):
            if flags == self.LOCK_UN:
                self.unlocked = True
                return

            self.lock_attempts += 1
            if self.lock_attempts <= self.busy_attempts:
                raise OSError(app_module.errno.EAGAIN, "busy")

    def test_scrcpy_stream_lock_waits_for_transient_busy_owner(self):
        fake_fcntl = self.FakeFcntl(busy_attempts=2)

        with tempfile.TemporaryDirectory() as temp_dir, patch("app.fcntl", fake_fcntl), patch(
            "app.SCRCPY_STREAM_LOCK_PATH", Path(temp_dir) / "scrcpy-video.lock"
        ), patch("app.SCRCPY_STREAM_LOCK_RETRY_INTERVAL_SECONDS", 0.001):
            with app_module.scrcpy_stream_lock(wait_seconds=0.1) as acquired:
                self.assertTrue(acquired)

        self.assertEqual(fake_fcntl.lock_attempts, 3)
        self.assertTrue(fake_fcntl.unlocked)

    def test_scrcpy_stream_lock_reports_busy_after_timeout(self):
        fake_fcntl = self.FakeFcntl(busy_attempts=10)

        with tempfile.TemporaryDirectory() as temp_dir, patch("app.fcntl", fake_fcntl), patch(
            "app.SCRCPY_STREAM_LOCK_PATH", Path(temp_dir) / "scrcpy-video.lock"
        ):
            with app_module.scrcpy_stream_lock(wait_seconds=0) as acquired:
                self.assertFalse(acquired)

        self.assertEqual(fake_fcntl.lock_attempts, 1)
        self.assertFalse(fake_fcntl.unlocked)


class ScrcpyVideoEndpointTests(unittest.TestCase):
    def test_scrcpy_video_returns_json_when_prerequisites_are_missing(self):
        client = app.test_client()
        with patch("app.video_prerequisite_error", return_value=("Emulator ADB target emulator:5555 is not ready", 503)):
            response = client.get("/scrcpy-video?bit_rate=1000000&max_size=720&max_fps=24")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json()["error"], "Emulator ADB target emulator:5555 is not ready")

    def test_scrcpy_video_streams_fragmented_mp4_and_uses_plain_http_headers(self):
        class FakeStdout:
            def __init__(self):
                self.chunks = [b"ftyp", b""]

            def read(self, size=-1):
                return self.chunks.pop(0) if self.chunks else b""

        class FakeProc:
            def __init__(self, stdout=None, stderr=None, polls=None):
                self.stdout = stdout
                self.stderr = stderr
                self._polls = list(polls or [None, 0])

            def poll(self):
                return self._polls.pop(0) if self._polls else 0

            def terminate(self):
                pass

            def wait(self, timeout=None):
                return 0

            def kill(self):
                pass

        popen_calls = []

        def fake_popen(cmd, **kwargs):
            popen_calls.append(cmd)
            if cmd[0] == "ffmpeg":
                return FakeProc(stdout=FakeStdout(), stderr=None, polls=[None, 0])
            return FakeProc(stdout=None, stderr=None, polls=[None, 0])

        client = app.test_client()
        with patch("app.video_prerequisite_error", return_value=None), patch("app.shutil.which", side_effect=lambda tool: f"/usr/bin/{tool}"), patch(
            "app.tempfile.gettempdir", return_value="/tmp"
        ), patch("app.os.mkfifo", create=True), patch("app.os.O_NONBLOCK", 0, create=True), patch("app.os.open", return_value=123), patch(
            "app.os.set_blocking"
        ), patch("app.os.fdopen", return_value=io.BytesIO()), patch("app.subprocess.Popen", side_effect=fake_popen):
            response = client.get("/scrcpy-video?bit_rate=1000000&max_size=720&max_fps=24", buffered=False)
            first_chunk = next(response.response)
            response.response.close()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(first_chunk, b"ftyp")
        self.assertIn("video/mp4", response.mimetype)
        self.assertEqual(response.headers.get("X-Accel-Buffering"), "no")
        self.assertTrue(
            any(
                call[0] == "scrcpy"
                and "--no-window" in call
                and "--no-playback" in call
                and "--no-audio" in call
                and "--port" in call
                and "27183:27283" in call
                and "--video-codec" in call
                and "h264" in call
                and "--video-bit-rate" in call
                and "--bit-rate" not in call
                and "--no-display" not in call
                and "--max-fps" in call
                and "24" in call
                and "--record-format" in call
                and "mkv" in call
                for call in popen_calls
            )
        )
        self.assertTrue(
            any(
                call[0] == "ffmpeg"
                and "-f" in call
                and "matroska" in call
                and "65536" in call
                and "empty_moov+default_base_moof+separate_moof+omit_tfhd_offset" in call
                and "-flush_packets" in call
                for call in popen_calls
            )
        )

    def test_scrcpy_video_falls_back_to_screenrecord_mp4_when_scrcpy_exits_before_frames(self):
        class FakePipe:
            def __init__(self, chunks):
                self.chunks = list(chunks)
                self.closed = False

            def read(self, size=-1):
                return self.chunks.pop(0) if self.chunks else b""

            def close(self):
                self.closed = True

        class FakeProc:
            def __init__(self, stdout=None, stderr=None, polls=None):
                self.stdout = stdout
                self.stderr = stderr
                self._polls = list(polls or [0])

            def poll(self):
                return self._polls.pop(0) if self._polls else 0

            def terminate(self):
                pass

            def wait(self, timeout=None):
                return 0

            def kill(self):
                pass

        popen_calls = []
        adb_calls = []
        ffmpeg_count = 0

        def fake_popen(cmd, **kwargs):
            nonlocal ffmpeg_count
            popen_calls.append(cmd)
            if cmd[0] == "ffmpeg":
                ffmpeg_count += 1
                if ffmpeg_count == 1:
                    return FakeProc(stdout=FakePipe([b""]), stderr=FakePipe([]), polls=[None, 0])
                return FakeProc(stdout=FakePipe([b"ftyp-fallback", b""]), stderr=FakePipe([]), polls=[None, 0])
            return FakeProc(
                stdout=None,
                stderr=FakePipe([b"bind: Address already in use\nERROR: Server connection failed\n"]),
                polls=[0],
            )

        def fake_adb_popen(*args):
            adb_calls.append(args)
            return FakeProc(stdout=FakePipe([b"h264"]), stderr=FakePipe([]), polls=[None, 0])

        client = app.test_client()
        with patch("app.video_prerequisite_error", return_value=None), patch("app.shutil.which", side_effect=lambda tool: f"/usr/bin/{tool}"), patch(
            "app.SCRCPY_STARTUP_TIMEOUT_SECONDS", 0.1
        ), patch("app.tempfile.gettempdir", return_value="/tmp"), patch("app.os.mkfifo", create=True), patch(
            "app.os.O_NONBLOCK", 0, create=True
        ), patch("app.os.open", return_value=123), patch("app.os.set_blocking"), patch("app.os.fdopen", return_value=io.BytesIO()), patch(
            "app.subprocess.Popen", side_effect=fake_popen
        ), patch("app.adb_popen", side_effect=fake_adb_popen):
            response = client.get("/scrcpy-video?bit_rate=1000000&max_size=720&max_fps=24", buffered=False)
            first_chunk = next(response.response)
            response.response.close()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(first_chunk, b"ftyp-fallback")
        self.assertTrue(any(call[0] == "scrcpy" for call in popen_calls))
        self.assertTrue(any(call[0] == "ffmpeg" and "-f" in call and "h264" in call for call in popen_calls))
        self.assertIn(
            (
                "exec-out",
                "screenrecord",
                "--output-format=h264",
                "--bit-rate",
                "1000000",
                "--time-limit",
                "180",
                "-",
            ),
            adb_calls,
        )

    def test_scrcpy_video_returns_conflict_when_scrcpy_stream_is_already_active(self):
        class BusyLock:
            def __enter__(self):
                return False

            def __exit__(self, exc_type, exc_value, traceback):
                return False

        client = app.test_client()
        with patch("app.video_prerequisite_error", return_value=None), patch("app.scrcpy_stream_lock", return_value=BusyLock()), patch(
            "app.subprocess.Popen"
        ) as popen_mock, patch("app.adb_popen") as adb_popen_mock:
            response = client.get("/scrcpy-video?bit_rate=1000000&max_size=720&max_fps=24", buffered=False)

        self.assertEqual(response.status_code, 409)
        self.assertIn("another scrcpy video stream is already active", response.get_json()["error"])
        popen_mock.assert_not_called()
        adb_popen_mock.assert_not_called()

    def test_scrcpy_video_returns_json_when_scrcpy_and_fallback_produce_no_frames(self):
        class FakePipe:
            def __init__(self, chunks):
                self.chunks = list(chunks)
                self.closed = False

            def read(self, size=-1):
                time.sleep(0.01)
                return self.chunks.pop(0) if self.chunks else b""

            def close(self):
                self.closed = True

        class FakeProc:
            def __init__(self, stdout=None, stderr=None, polls=None):
                self.stdout = stdout
                self.stderr = stderr
                self._polls = list(polls or [0])

            def poll(self):
                return self._polls.pop(0) if self._polls else 0

            def terminate(self):
                pass

            def wait(self, timeout=None):
                return 0

            def kill(self):
                pass

        ffmpeg_count = 0

        def fake_popen(cmd, **kwargs):
            nonlocal ffmpeg_count
            if cmd[0] == "ffmpeg":
                ffmpeg_count += 1
                return FakeProc(stdout=FakePipe([b""]), stderr=FakePipe([b"ffmpeg no frames\n"]), polls=[None, 0])
            return FakeProc(stdout=None, stderr=FakePipe([b"ERROR: Server connection failed\n"]), polls=[0])

        def fake_adb_popen(*args):
            return FakeProc(stdout=FakePipe([b""]), stderr=FakePipe([b"screenrecord no frames\n"]), polls=[0])

        client = app.test_client()
        with patch("app.video_prerequisite_error", return_value=None), patch("app.shutil.which", side_effect=lambda tool: f"/usr/bin/{tool}"), patch(
            "app.SCRCPY_STARTUP_TIMEOUT_SECONDS", 0.1
        ), patch("app.SCREENRECORD_RETRY_DELAY_SECONDS", 0), patch("app.SCREENRECORD_MAX_CONSECUTIVE_FAILURES", 1), patch(
            "app.tempfile.gettempdir", return_value="/tmp"
        ), patch("app.os.mkfifo", create=True), patch("app.os.O_NONBLOCK", 0, create=True), patch("app.os.open", return_value=123), patch(
            "app.os.set_blocking"
        ), patch("app.os.fdopen", return_value=io.BytesIO()), patch("app.subprocess.Popen", side_effect=fake_popen), patch(
            "app.adb_popen", side_effect=fake_adb_popen
        ):
            started_at = time.monotonic()
            response = client.get("/scrcpy-video?bit_rate=1000000&max_size=720&max_fps=24", buffered=False)

        self.assertEqual(response.status_code, 503)
        self.assertIn("scrcpy failed and adb screenrecord fallback produced no video", response.get_json()["error"])
        self.assertLess(time.monotonic() - started_at, 1.0)


if __name__ == "__main__":
    unittest.main()
