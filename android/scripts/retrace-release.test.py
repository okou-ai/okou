"""Exercise stack selection with the report layouts used by Android CI."""

from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("retrace-release.py")
retrace = runpy.run_path(str(SCRIPT))


class ReleaseRetraceTest(unittest.TestCase):
    def test_ci_only_selects_app_crashes(self):
        with tempfile.TemporaryDirectory() as directory:
            logcat = Path(directory) / "logcat.log"
            logcat.write_text(
                "11-20 19:09:19.339  100  100 I Okou: at noncrash.a.b(Source:1)\n"
                "11-20 19:09:19.339  120  120 E AndroidRuntime: FATAL EXCEPTION: main\n"
                "11-20 19:09:19.339  120  120 E AndroidRuntime: Process: other.app, PID: 120\n"
                "11-20 19:09:19.339  100  100 E AndroidRuntime: FATAL EXCEPTION: main\n"
                "11-20 19:09:19.339  100  100 E AndroidRuntime: Process: ai.okou.android, PID: 100\n"
                "11-20 19:09:19.339  120  120 E AndroidRuntime: \tat other.a.b(Source:2)\n"
                "11-20 19:09:19.339  100  100 E AndroidRuntime: \tat app.a.b(Source:7)\n"
                "11-20 19:09:19.339  100  100 E AndroidRuntime: Caused by: app.a.c\n"
                "11-20 19:09:19.339  100  100 E AndroidRuntime: \tat app.d.e(Source:9)\n"
            )
            expected = (
                "FATAL EXCEPTION: main\nProcess: ai.okou.android, PID: 100\n"
                "\tat app.a.b(Source:7)\nCaused by: app.a.c\n\tat app.d.e(Source:9)"
            )
            self.assertEqual(list(retrace["logcat_stacks"](logcat)), [expected])

    def test_ci_skips_resolution_when_logcat_has_no_stack(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logcat = root / "logcat.log"
            logcat.write_text("11-20 19:09:19.339  100  100 I Okou: sign-in view timed out\n")
            output = root / "retraced"
            result = subprocess.run(
                [sys.executable, SCRIPT, root / "missing.apk", root / "missing-map.gz",
                 logcat, output, "--ci-logcat"], capture_output=True, text=True, timeout=5,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("No Release app crash stacks", result.stdout)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
