#!/usr/bin/env python3
"""Real process/file coverage for the owned calibration collector."""

import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import unittest.mock
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "runner-memory-calibrate.py"
SPEC = importlib.util.spec_from_file_location("memory_calibrate", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory(prefix="runner-memory-collector-")
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name)
        self.metadata = self.root / "metadata.json"
        self.metadata.write_text(
            json.dumps({"scenario": "process-smoke", "native_corpus": "not_executed"})
        )

    def command(self, output, program, *options):
        return [
            sys.executable,
            str(SCRIPT),
            "--output",
            str(output),
            "--metadata",
            str(self.metadata),
            "--minimum-available-mib",
            "1",
            "--duration-seconds",
            "3",
            "--interval-seconds",
            "0.05",
            "--cleanup-grace-seconds",
            "0.1",
            *options,
            "--",
            sys.executable,
            "-c",
            program,
        ]

    def run_case(self, program, *options):
        output = self.root / "result"
        result = subprocess.run(
            self.command(output, program, *options),
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        report = json.loads((output / "report.json").read_text())
        self.assertTrue(report["driver_wait_confirmed"], result.stderr)
        self.assertTrue(report["cleanup_confirmed"], report)
        self.assertEqual(report["remaining_children"], [])
        self.assertFalse(report["calibrated"])
        self.assertFalse(report["native_vm_exit_confirmed"])
        return result, report, output

    def test_real_residency_host_samples_and_positive_wait(self):
        result, report, output = self.run_case(
            "import time; data=bytearray(16*1024*1024); print('active-owned-smoke',flush=True); time.sleep(0.2)"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(report["success"])
        samples = [
            json.loads(line)
            for line in (output / "samples.jsonl").read_text().splitlines()
        ]
        self.assertGreaterEqual(len(samples), 2)
        self.assertTrue(all(sample["mem_available_bytes"] >= 0 for sample in samples))
        self.assertTrue(
            any(
                process["rss_bytes"] is not None
                and process["rss_bytes"] > 0
                and process["pss_bytes"] > 0
                and process["start_ticks"] > 0
                for sample in samples
                for process in sample["processes"]
            )
        )
        self.assertIn("active-owned-smoke", (output / "stdout.log").read_text())

    def test_worker_thread_children_are_sampled_and_reaped(self):
        # Wait for the externally written sample, not a guessed scheduling delay.
        program = """
import json, os, subprocess, sys, threading, time
from pathlib import Path
ready = threading.Event()
child = []
def worker():
    process = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
    child.append(process.pid)
    print(process.pid, flush=True)
    ready.set()
    time.sleep(60)
threading.Thread(target=worker).start()
if not ready.wait(2):
    os._exit(2)
deadline = time.monotonic() + 2
while time.monotonic() < deadline:
    for line in Path('samples.jsonl').read_text().splitlines(keepends=True):
        if not line.endswith('\\n'):
            continue
        sample = json.loads(line)
        if any(p['pid'] == child[0] and p['rss_bytes'] is not None for p in sample['processes']):
            os._exit(0)
    time.sleep(0.01)
os._exit(3)
"""
        _, report, output = self.run_case(program)
        child = int((output / "stdout.log").read_text().strip())
        samples = [
            json.loads(line)
            for line in (output / "samples.jsonl").read_text().splitlines()
        ]
        self.assertTrue(
            any(
                process["pid"] == child and process["rss_bytes"] is not None
                for sample in samples
                for process in sample["processes"]
            )
        )
        self.assertIsNone(MODULE.process_identity(child))
        self.assertTrue(
            any(wait["pid"] == child for wait in report["adopted_child_waits"])
        )

    def test_fixture_does_not_inherit_provider_credentials(self):
        with unittest.mock.patch.dict(
            os.environ, {"SYNTHETIC_ONLY_TEST_SECRET": "fixture-placeholder"}
        ):
            result, _, output = self.run_case(
                "import os; assert 'SYNTHETIC_ONLY_TEST_SECRET' not in os.environ; assert os.environ['HOME']==os.getcwd(); print('isolated-environment')"
            )
        self.assertEqual(result.returncode, 0)
        self.assertIn("isolated-environment", (output / "stdout.log").read_text())

    def test_nonzero_exit_is_not_native_or_measurement_success(self):
        result, report, _ = self.run_case("import sys; sys.exit(7)")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["driver_exit_code"], 7)
        self.assertFalse(report["success"])

    def test_timeout_reaps_owned_term_resistant_descendant(self):
        program = "import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c','import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)']); print(p.pid,flush=True); time.sleep(60)"
        result, report, output = self.run_case(program, "--duration-seconds", "0.4")
        self.assertEqual(result.returncode, 1)
        self.assertTrue(report["timed_out"])
        self.assertFalse(report["success"])
        child = int((output / "stdout.log").read_text().strip())
        self.assertIsNone(MODULE.process_identity(child))
        self.assertTrue(
            any(wait["pid"] == child for wait in report["adopted_child_waits"])
        )

    def test_parent_exit_does_not_hide_surviving_owned_child(self):
        program = "import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); print(p.pid,flush=True); time.sleep(0.1)"
        result, report, output = self.run_case(program)
        child = int((output / "stdout.log").read_text().strip())
        self.assertIsNone(MODULE.process_identity(child))
        self.assertTrue(report["cleanup_confirmed"])
        self.assertTrue(report["cleanup_intervened"])
        self.assertFalse(report["success"])
        self.assertEqual(result.returncode, 1)
        self.assertTrue(
            any(wait["pid"] == child for wait in report["adopted_child_waits"])
        )

    def test_high_output_is_bounded_and_truncation_explicit(self):
        result, report, output = self.run_case(
            "import sys; sys.stdout.write('x'*(2*1024*1024)); sys.stderr.write('y'*(2*1024*1024))",
            "--max-log-bytes",
            "1024",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(report["logs_truncated"])
        self.assertEqual((output / "stdout.log").stat().st_size, 1024)
        self.assertEqual((output / "stderr.log").stat().st_size, 1024)

    def test_sigterm_cancels_and_joins_owned_command(self):
        output = self.root / "cancelled"
        process = subprocess.Popen(
            self.command(
                output, "import time; print('ready',flush=True); time.sleep(60)"
            ),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            log = output / "stdout.log"
            if log.exists() and log.stat().st_size:
                break
            time.sleep(0.02)
        process.send_signal(signal.SIGTERM)
        stdout, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 1, (stdout, stderr))
        report = json.loads((output / "report.json").read_text())
        self.assertTrue(report["driver_wait_confirmed"])
        self.assertFalse(report["success"])
        self.assertEqual(report["remaining_children"], [])
        self.assertTrue(report["errors"])

    def test_output_reuse_and_symlink_rejected_before_launch(self):
        for output in (self.root / "existing", self.root / "link" / "output"):
            if output.name == "existing":
                output.mkdir()
            else:
                (self.root / "link").symlink_to(self.root, target_is_directory=True)
            marker = self.root / "launched"
            result = subprocess.run(
                self.command(output, f"open({str(marker)!r},'w').close()"),
                capture_output=True,
                timeout=5,
                check=False,
            )
            self.assertEqual(result.returncode, 1)
            self.assertFalse(marker.exists())

    def test_replaceable_output_parent_rejected_before_launch(self):
        parent = self.root / "replaceable"
        parent.mkdir()
        parent.chmod(0o777)
        marker = self.root / "launched"
        result = subprocess.run(
            self.command(parent / "output", f"open({str(marker)!r},'w').close()"),
            capture_output=True,
            timeout=5,
            check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertFalse(marker.exists())

    def test_invalid_limits_rejected_without_launch(self):
        for limit in ("nan", "inf", "-1", "601"):
            result = subprocess.run(
                self.command(
                    self.root / "invalid",
                    "raise AssertionError('launched')",
                    "--duration-seconds",
                    limit,
                ),
                capture_output=True,
                timeout=5,
                check=False,
            )
            self.assertEqual(result.returncode, 1)
            self.assertFalse((self.root / "invalid").exists())

    def test_strict_available_zero_units_and_overflow(self):
        self.assertEqual(MODULE.available_bytes(b"MemAvailable: 0 kB\n"), 0)
        self.assertEqual(MODULE.available_bytes(b"MemAvailable: 12 kB\n"), 12288)
        for content in (
            b"MemTotal: 1 kB",
            b"MemAvailable: 1 MB",
            b"MemAvailable: -1 kB",
            b"MemAvailable: 1 kB\nMemAvailable: 2 kB",
            b"MemAvailable: 18446744073709551616 kB",
        ):
            with self.assertRaises(ValueError):
                MODULE.available_bytes(content)

    def test_pid_generation_change_discards_residency(self):
        with (
            unittest.mock.patch.object(
                MODULE, "process_identity", side_effect=[(1, "R"), (2, "R")]
            ),
            unittest.mock.patch.object(
                MODULE, "bounded_read", return_value=b"Rss: 10 kB\nPss: 8 kB\n"
            ),
        ):
            self.assertIsNone(MODULE.residency(123, 1))


if __name__ == "__main__":
    unittest.main()
