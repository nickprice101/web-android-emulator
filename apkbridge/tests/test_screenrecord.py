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


if __name__ == "__main__":
    unittest.main()
