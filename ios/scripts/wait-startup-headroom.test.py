#!/usr/bin/env python3
"""Exercise the actual observer against a controlled external iostat process."""

import os
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("wait-startup-headroom.py")
MOCK = """#!/usr/bin/env python3
import os, pathlib, signal, sys
root = pathlib.Path(os.environ['HEADROOM_FIXTURE'])
def stop(signum, frame):
    (root / 'stopped').touch()
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
print('disk0 cpu load average', flush=True)
print('1 1 1 0 0 99 0 0 0', flush=True)
scenario = os.environ['HEADROOM_SCENARIO']
if scenario == 'empty': sys.exit(0)
values = [0, 30, 0, 25, 40] if scenario == 'ready' else [0]
for idle in values:
    print(f'1 1 1 40 60 {idle} 1 2 3', flush=True)
(root / 'started').touch()
signal.pause()
"""


class HeadroomTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        executable = self.root / "iostat"
        executable.write_text(MOCK)
        executable.chmod(0o755)
        self.env = os.environ | {
            "PATH": f"{self.root}:{os.environ['PATH']}",
            "HEADROOM_FIXTURE": str(self.root),
            "HEADROOM_SCENARIO": "ready",
        }

    def test_only_recent_consecutive_windows_establish_headroom(self):
        result = subprocess.run(
            ["python3", str(SCRIPT)],
            env=self.env,
            text=True,
            capture_output=True,
            timeout=5,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("headroom: ready", result.stdout)
        self.assertIn("observations=5", result.stdout)
        self.assertTrue((self.root / "stopped").exists())

    def test_unsupported_observation_returns_an_explicit_noop_fallback(self):
        self.env["HEADROOM_SCENARIO"] = "empty"
        result = subprocess.run(
            ["python3", str(SCRIPT)],
            env=self.env,
            text=True,
            capture_output=True,
            timeout=5,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("headroom: unavailable", result.stdout)
        self.assertIn("observations=0", result.stdout)

    def test_zero_budget_does_not_start_a_diagnostic_child(self):
        result = subprocess.run(
            ["python3", str(SCRIPT), "--max-seconds", "0"],
            env=self.env,
            text=True,
            capture_output=True,
            timeout=5,
            check=False,
        )
        self.assertEqual(result.returncode, 0)
        self.assertIn("headroom: deadline", result.stdout)
        self.assertFalse((self.root / "started").exists())

    def test_cancellation_retires_the_owned_iostat_process(self):
        self.env["HEADROOM_SCENARIO"] = "busy"
        with subprocess.Popen(
            ["python3", str(SCRIPT)],
            env=self.env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        ) as process:
            deadline = time.monotonic() + 3
            while not (self.root / "started").exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue((self.root / "started").exists())
            process.send_signal(signal.SIGTERM)
            _, stderr = process.communicate(timeout=3)
            self.assertEqual(process.returncode, 143, stderr)
        self.assertTrue((self.root / "stopped").exists())


if __name__ == "__main__":
    unittest.main()
