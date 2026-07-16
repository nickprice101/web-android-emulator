import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app as app_module  # noqa: E402
from app import app  # noqa: E402


class LogFilterExpressionTests(unittest.TestCase):
    def test_plain_filter_is_case_insensitive(self):
        self.assertTrue(app_module.log_line_matches_filter("ActivityManager: START", "activitymanager"))
        self.assertFalse(app_module.log_line_matches_filter("WindowManager: focus", "activitymanager"))

    def test_and_requires_every_term(self):
        expression = "ActivityManager AND crash"

        self.assertTrue(app_module.log_line_matches_filter("ActivityManager reported a CRASH", expression))
        self.assertFalse(app_module.log_line_matches_filter("ActivityManager started an app", expression))

    def test_or_accepts_either_term(self):
        expression = "timeout OR refused"

        self.assertTrue(app_module.log_line_matches_filter("Connection timed out: timeout", expression))
        self.assertTrue(app_module.log_line_matches_filter("Connection refused", expression))
        self.assertFalse(app_module.log_line_matches_filter("Connection succeeded", expression))

    def test_and_is_evaluated_before_or(self):
        expression = "ActivityManager AND crash OR timeout"

        self.assertTrue(app_module.log_line_matches_filter("ActivityManager crash", expression))
        self.assertTrue(app_module.log_line_matches_filter("Network timeout", expression))
        self.assertFalse(app_module.log_line_matches_filter("ActivityManager started", expression))

    def test_lowercase_operator_word_remains_literal_text(self):
        self.assertTrue(app_module.log_line_matches_filter("cats and dogs", "cats and dogs"))
        self.assertFalse(app_module.log_line_matches_filter("cats dogs", "cats and dogs"))


class LogFilterEndpointTests(unittest.TestCase):
    LOG_LINES = "\n".join(
        [
            "07-16 09:00:00 ActivityManager: app started",
            "07-16 09:00:01 ActivityManager: fatal crash",
            "07-16 09:00:02 NetworkMonitor: timeout",
        ]
    )

    def test_include_mode_keeps_matching_lines(self):
        client = app.test_client()
        with patch("app.adb", return_value=self.LOG_LINES):
            response = client.get(
                "/logcat?include_crash=0&filter=ActivityManager+AND+crash&filter_mode=include"
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["entries"], ["07-16 09:00:01 ActivityManager: fatal crash"])

    def test_exclude_mode_removes_matching_lines(self):
        client = app.test_client()
        with patch("app.adb", return_value=self.LOG_LINES):
            response = client.get(
                "/logcat?include_crash=0&filter=ActivityManager+AND+crash+OR+timeout&filter_mode=exclude"
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["entries"], ["07-16 09:00:00 ActivityManager: app started"])


if __name__ == "__main__":
    unittest.main()
