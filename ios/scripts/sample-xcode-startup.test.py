#!/usr/bin/env python3
"""Exercise startup observations against controlled compiler and diagnostic processes."""

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("sample-xcode-startup.py")
MOCK = r"""#!/usr/bin/env python3
import json, os, pathlib, signal, subprocess, sys, time
state = pathlib.Path(os.environ['SAMPLING_TEST_STATE'])
reports = pathlib.Path(os.environ['SAMPLING_TEST_REPORTS'])
scenario = os.environ['SAMPLING_TEST_SCENARIO']
command = pathlib.Path(sys.argv[0]).name
role = command
if '--grandchild' in sys.argv:
    role = 'grandchild'
def mark(name):
    (state / name).write_text(str(os.getpid()))
def wait_for(predicate):
    deadline = time.monotonic() + 5
    while not predicate():
        if time.monotonic() >= deadline:
            sys.exit('Missing causal marker for ' + role)
        time.sleep(0.01)
def event_exists(event, tool=None):
    path = reports / 'events.jsonl'
    if not path.exists():
        return False
    for line in path.read_text().splitlines():
        try:
            item = json.loads(line)
            if item['event'] == event and (tool is None or item.get('tool') == tool):
                return True
        except json.JSONDecodeError:
            pass
    return False
def stopped(signum, frame):
    mark(role + '-stopped')
    sys.exit(128 + signum)
signal.signal(signal.SIGTERM, stopped)
if command == 'xcodebuild':
    mark(role + '-started')
    if role == 'grandchild':
        wait_for(lambda: False)
    elif scenario == 'cancel':
        subprocess.Popen([sys.argv[0], '--grandchild'])
        wait_for(lambda: False)
    elif scenario == 'window':
        wait_for(lambda: event_exists('observation_window_ended'))
        print('Command line invocation:\ncompile after observation window', flush=True)
    elif scenario == 'fast-failure':
        print('compiler stdout', flush=True)
        print('compiler stderr', file=sys.stderr, flush=True)
        sys.exit(65)
    else:
        wait_for(lambda: (state / 'sample-finished').exists())
        if scenario == 'unavailable':
            wait_for(lambda: event_exists('observation', 'sample'))
        print('Command line invocation:', flush=True)
        wait_for(lambda: event_exists('observer_stopped'))
        print('build continues after observations stop', flush=True)
elif command == 'ps':
    wait_for(lambda: (state / 'xcodebuild-started').exists())
    pid = (state / 'xcodebuild-started').read_text()
    print(pid + ' 1 80.0 1.0 1024 R 0:01.00 /Applications/Xcode/xcodebuild')
elif command == 'sample':
    mark('sample-started')
    if scenario == 'cancel':
        wait_for(lambda: False)
    if scenario == 'unavailable':
        mark('sample-finished')
        sys.exit('sample: permission denied')
    target = pathlib.Path(sys.argv[sys.argv.index('-file') + 1])
    target.write_text('Thread_0 startup_wait\n' + ('x' * 300000))
    mark('sample-finished')
else:
    print(command + ' controlled observation')
"""


class StartupSamplingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        self.state.mkdir()
        self.reports = self.root / "reports"
        mock = self.root / "bin"
        mock.mkdir()
        for name in ("xcodebuild", "ps", "vm_stat", "iostat", "sample"):
            executable = mock / name
            executable.write_text(MOCK)
            executable.chmod(0o755)
        self.env = os.environ | {
            "PATH": f"{mock}:{os.environ['PATH']}",
            "SAMPLING_TEST_STATE": str(self.state),
            "SAMPLING_TEST_REPORTS": str(self.reports),
            "SAMPLING_TEST_SCENARIO": "observed",
            "UNRELATED_SECRET": "environment-secret-must-not-be-recorded",
        }

    def command(self, *options):
        return [
            sys.executable,
            str(SCRIPT),
            "--delay",
            "0",
            *options,
            str(self.reports),
            "--",
            "xcodebuild",
            "argument-secret-must-not-be-recorded",
        ]

    def invoke(self, *options):
        return subprocess.run(
            self.command(*options),
            env=self.env,
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )

    def events(self):
        return [
            json.loads(line)
            for line in (self.reports / "events.jsonl").read_text().splitlines()
        ]

    def summary(self):
        return json.loads((self.reports / "summary.json").read_text())

    def await_marker(self, name):
        deadline = time.monotonic() + 5
        while not (self.state / name).exists():
            if time.monotonic() >= deadline:
                self.fail(f"Missing process lifecycle marker: {name}")
            time.sleep(0.01)

    def test_compiler_output_and_failure_reach_the_caller(self):
        self.env["SAMPLING_TEST_SCENARIO"] = "fast-failure"
        result = self.invoke()
        self.assertEqual(result.returncode, 65, result.stderr)
        self.assertIn("compiler stdout", result.stdout)
        self.assertIn("compiler stderr", result.stdout)
        self.assertEqual(self.summary()["exit_code"], 65)

    def test_banner_stops_observation_while_compilation_continues(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("build continues after observations stop", result.stdout)
        self.assertIsNotNone(self.summary()["command_banner_seconds"])
        events = self.events()
        names = [event["event"] for event in events]
        self.assertLess(
            names.index("command_banner"), names.index("observer_stopped")
        )
        self.assertLess(
            names.index("observer_stopped"), names.index("compiler_finished")
        )
        self.assertTrue(
            all("utc" in event and "elapsed_seconds" in event for event in events)
        )
        self.assertTrue(list(self.reports.glob("*-disk-cpu.txt")))
        report = next(self.reports.glob("*.sample.txt"))
        self.assertIn("startup_wait", report.read_text())
        self.assertLessEqual(report.stat().st_size, 256 * 1024)
        self.assertIn("report_truncated", names)

    def test_diagnostic_failure_is_visible_without_failing_the_compiler(self):
        self.env["SAMPLING_TEST_SCENARIO"] = "unavailable"
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        failures = [event for event in self.events() if event.get("tool") == "sample"]
        self.assertTrue(
            any(event.get("exit_code") == 1 for event in failures), failures
        )
        self.assertIn(
            "permission denied", next(self.reports.glob("*-sampler.txt")).read_text()
        )

    def test_observation_deadline_leaves_the_compiler_running(self):
        self.env["SAMPLING_TEST_SCENARIO"] = "window"
        result = self.invoke("--window", "1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("compile after observation window", result.stdout)
        self.assertIn(
            "observation_window_ended", [event["event"] for event in self.events()]
        )

    def test_reports_exclude_arguments_and_environment(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        for path in self.reports.iterdir():
            content = path.read_text()
            self.assertNotIn("argument-secret-must-not-be-recorded", content)
            self.assertNotIn("environment-secret-must-not-be-recorded", content)

    def test_cancellation_retires_compiler_descendants_and_active_diagnostics(self):
        self.env["SAMPLING_TEST_SCENARIO"] = "cancel"
        with subprocess.Popen(
            self.command(),
            env=self.env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        ) as process:
            try:
                self.await_marker("grandchild-started")
                self.await_marker("sample-started")
            finally:
                process.send_signal(signal.SIGTERM)
                _, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 143, stderr)
        for role in ("xcodebuild", "grandchild", "sample"):
            self.await_marker(role + "-stopped")
        self.assertTrue(self.summary()["cancelled"])
        self.assertEqual(self.summary()["exit_code"], 143)


if __name__ == "__main__":
    unittest.main()
