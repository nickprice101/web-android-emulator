import io
import subprocess
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import app  # noqa: E402


def make_python_proc(code):
    return subprocess.Popen(
        [sys.executable, "-c", code],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
    )


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
        with patch("app.video_prerequisite_error", return_value=None), patch("app.tempfile.gettempdir", return_value="/tmp"), patch("app.os.mkfifo", create=True), patch(
            "app.os.O_NONBLOCK", 0, create=True
        ), patch("app.os.open", return_value=123), patch("app.os.set_blocking"), patch("app.os.fdopen", return_value=io.BytesIO()), patch(
            "app.subprocess.Popen", side_effect=fake_popen
        ):
            response = client.get("/scrcpy-video?bit_rate=1000000&max_size=720&max_fps=24", buffered=False)
            first_chunk = next(response.response)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(first_chunk, b"ftyp")
        self.assertIn("video/mp4", response.mimetype)
        self.assertEqual(response.headers.get("X-Accel-Buffering"), "no")
        self.assertTrue(
            any(
                call[0] == "scrcpy"
                and "--no-window" in call
                and "--no-audio" in call
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
        self.assertTrue(any(call[0] == "ffmpeg" and "empty_moov+default_base_moof+separate_moof+omit_tfhd_offset" in call and "-flush_packets" in call for call in popen_calls))

    def test_scrcpy_video_returns_json_when_scrcpy_exits_before_frames(self):
        class FakeStdout:
            def read(self, size=-1):
                time.sleep(0.05)
                return b""

        class FakeStderr:
            def __init__(self, chunks):
                self.chunks = list(chunks)

            def read(self, size=-1):
                return self.chunks.pop(0) if self.chunks else b""

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

        def fake_popen(cmd, **kwargs):
            if cmd[0] == "ffmpeg":
                return FakeProc(stdout=FakeStdout(), stderr=FakeStderr([]), polls=[None, None])
            return FakeProc(stdout=None, stderr=FakeStderr([b"ERROR: Unknown option --no-display\n"]), polls=[0])

        client = app.test_client()
        with patch("app.video_prerequisite_error", return_value=None), patch("app.SCRCPY_STARTUP_TIMEOUT_SECONDS", 0.1), patch("app.tempfile.gettempdir", return_value="/tmp"), patch(
            "app.os.mkfifo", create=True
        ), patch("app.os.O_NONBLOCK", 0, create=True), patch("app.os.open", return_value=123), patch("app.os.set_blocking"), patch(
            "app.os.fdopen", return_value=io.BytesIO()
        ), patch("app.subprocess.Popen", side_effect=fake_popen):
            started_at = time.monotonic()
            response = client.get("/scrcpy-video?bit_rate=1000000&max_size=720&max_fps=24", buffered=False)

        self.assertEqual(response.status_code, 503)
        self.assertIn("scrcpy exited before producing video", response.get_json()["error"])
        self.assertLess(time.monotonic() - started_at, 1.0)


if __name__ == "__main__":
    unittest.main()
