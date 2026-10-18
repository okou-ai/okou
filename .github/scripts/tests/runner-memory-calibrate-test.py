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
        # Retain the working set until real samples arrive, not a guessed delay.
        program = """
import json, os, sys, time
from pathlib import Path
data = bytearray(16*1024*1024)
print('active-owned-smoke', flush=True)
pid = os.getpid()
deadline = time.monotonic() + 2
while time.monotonic() < deadline:
    observed = 0
    for line in Path('samples.jsonl').read_text().splitlines(keepends=True):
        if not line.endswith('\\n'):
            continue
        sample = json.loads(line)
        if any(p['pid'] == pid and p['rss_bytes'] is not None and p['rss_bytes'] > 0 and p['pss_bytes'] > 0 for p in sample['processes']):
            observed += 1
    if observed >= 2:
        sys.exit(0)
    time.sleep(0.01)
sys.exit(3)
"""
        result, report, output = self.run_case(program)
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

    def test_reaped_child_keeps_positive_exit_diagnostics_and_null_residency(self):
        program = """
import json, subprocess, sys, time
from pathlib import Path
child = subprocess.Popen([sys.executable, '-c', 'import sys; sys.stdin.read(1)'], stdin=subprocess.PIPE)
print(child.pid, flush=True)
deadline = time.monotonic() + 2
released = False
while time.monotonic() < deadline:
    for line in Path('samples.jsonl').read_text().splitlines(keepends=True):
        if not line.endswith('\\n'):
            continue
        for row in json.loads(line)['processes']:
            if row['pid'] != child.pid:
                continue
            if row['residency_state'] == 'measured' and not released:
                child.stdin.write(b'x'); child.stdin.close()
                assert child.wait(timeout=1) == 0
                released = True
            if row['residency_state'] == 'exited':
                assert released
                assert row['residency_reason'] == 'pidfd_exit'
                assert row['rss_bytes'] is None and row['pss_bytes'] is None
                assert 0 < row['exit_observed_monotonic_ns'] <= row['observed_monotonic_ns']
                sys.exit(0)
    time.sleep(0.01)
sys.exit(3)
"""
        result, report, output = self.run_case(program)
        self.assertEqual(result.returncode, 0, (result.stderr, report))
        self.assertEqual(report["format"], "runner-memory-calibration-v2")
        self.assertTrue(report["success"])
        self.assertGreater(report["residency_incomplete_samples"], 0)
        pid = int((output / "stdout.log").read_text().strip())
        samples = [json.loads(line) for line in (output / "samples.jsonl").read_text().splitlines()]
        captured = set()
        for sample in samples:
            identities = {(row["pid"], row["start_ticks"]) for row in sample["processes"]}
            self.assertLessEqual(captured, identities)
            captured = identities
        rows = [
            row
            for sample in samples
            for row in sample["processes"]
            if row["pid"] == pid
        ]
        self.assertEqual(len({row["start_ticks"] for row in rows}), 1)
        self.assertTrue(any(row["residency_state"] == "measured" for row in rows))
        self.assertTrue(any(row["residency_state"] == "exited" for row in rows))

    def test_collector_retires_observation_fds_on_success_failure_and_cancellation(self):
        wrapper = """
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location('owned_collector', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
sys.argv = sys.argv[1:]
before = len(os.listdir('/proc/self/fd'))
if FAIL_CLOSE:
    original_close = module.selectors.DefaultSelector.close
    def fail_close(selector):
        if selector.get_map() is not None:
            original_close(selector)
            raise OSError(5, 'controlled selector close failure')
    module.selectors.DefaultSelector.close = fail_close
code = module.main()
assert len(os.listdir('/proc/self/fd')) == before, 'collector leaked an observation or I/O fd'
assert module.child_pids(os.getpid()) == [], 'collector retained a child after cleanup'
sys.exit(code)
"""
        for outcome in ("success", "driver_failure", "cancelled", "selector_failure"):
            with self.subTest(outcome=outcome):
                output = self.root / f"{outcome}-fds"
                program = """
import json, os, signal, sys, time
from pathlib import Path
deadline = time.monotonic() + 2
while time.monotonic() < deadline:
    for line in Path('samples.jsonl').read_text().splitlines(keepends=True):
        if not line.endswith('\\n'):
            continue
        if any(p['pid'] == os.getpid() and p['residency_state'] == 'measured'
               for p in json.loads(line)['processes']):
            if CANCEL:
                os.kill(os.getppid(), signal.SIGTERM)
                time.sleep(60)
            sys.exit(EXIT_CODE)
    time.sleep(0.01)
sys.exit(9)
""".replace("CANCEL", repr(outcome in ("cancelled", "selector_failure"))).replace(
                    "EXIT_CODE", "3" if outcome == "driver_failure" else "0"
                )
                command = self.command(output, program)
                wrapper_program = wrapper.replace(
                    "FAIL_CLOSE", repr(outcome == "selector_failure")
                )
                result = subprocess.run(
                    [sys.executable, "-c", wrapper_program, *command[1:]],
                    capture_output=True, text=True, timeout=15,
                )
                self.assertEqual(
                    result.returncode, int(outcome != "success"), result.stderr
                )
                if outcome == "selector_failure":
                    self.assertIn("controlled selector close failure", result.stderr)
                    self.assertNotIn("collector leaked", result.stderr)
                    self.assertFalse((output / "report.json").exists())
                    continue
                report = json.loads((output / "report.json").read_text())
                self.assertEqual(report["success"], outcome == "success")
                if outcome == "driver_failure":
                    self.assertEqual(report["driver_exit_code"], 3)
                self.assertEqual(report["remaining_children"], [])
                self.assertTrue(report["cleanup_confirmed"])

    def test_opaque_process_name_preserves_identity_residency_and_owned_signal(self):
        # /proc/<pid>/stat comm is an opaque kernel byte string, not ASCII.
        program = (
            "import ctypes,os,sys; libc=ctypes.CDLL(None); "
            "name=ctypes.c_char_p(b'fixture-'+bytes([255])+b')')\n"
            "if libc.prctl(15,name,0,0,0)!=0: sys.exit(2)\n"
            "print(os.getpid(),flush=True); sys.stdin.read(1)"
        )
        with subprocess.Popen(
            [sys.executable, "-c", program],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        ) as child:
            try:
                self.assertEqual(int(child.stdout.readline()), child.pid)
                self.assertEqual(
                    Path(f"/proc/{child.pid}/comm").read_bytes(), b"fixture-\xff)\n"
                )
                generation, state, parent = MODULE.process_identity(child.pid)
                self.assertGreater(generation, 0)
                self.assertNotEqual(state, "Z")
                self.assertEqual(parent, os.getpid())
                measurement = MODULE.residency(child.pid, generation)
                self.assertIsNotNone(measurement)
                self.assertGreater(measurement["rss_bytes"], 0)
                MODULE.signal_owned({child.pid: generation}, signal.SIGTERM)
                self.assertEqual(child.wait(timeout=5), -signal.SIGTERM)
            finally:
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=5)

    def test_fixture_does_not_inherit_provider_credentials(self):
        with unittest.mock.patch.dict(
            os.environ, {"SYNTHETIC_ONLY_TEST_SECRET": "fixture-placeholder"}
        ):
            result, _, output = self.run_case(
                "import os; assert 'SYNTHETIC_ONLY_TEST_SECRET' not in os.environ; assert os.environ['HOME']==os.getcwd(); print('isolated-environment')"
            )
        self.assertEqual(result.returncode, 0)
        self.assertIn("isolated-environment", (output / "stdout.log").read_text())

    def test_ignored_sigchld_is_rejected_before_fixture_launch(self):
        output = self.root / "unwaitable"
        marker = self.root / "launched"
        command = self.command(
            output,
            f"from pathlib import Path; import sys; Path({str(marker)!r}).touch(); sys.exit(7)",
        )
        # Ignored dispositions survive exec. Popen can otherwise turn ECHILD
        # into returncode 0, falsely reporting a failed fixture as positively waited.
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                "import os,signal,sys; signal.signal(signal.SIGCHLD,signal.SIG_IGN); os.execv(sys.executable,[sys.executable,*sys.argv[1:]])",
                *command[1:],
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(result.returncode, 1, (result.stdout, result.stderr))
        self.assertIn("SIGCHLD", result.stderr)
        self.assertFalse(marker.exists())
        self.assertFalse(output.exists())

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

    def test_slow_kernel_sample_cannot_hide_an_expired_driver_deadline(self):
        output = self.root / "slow-sample-deadline"
        # Delay only the external procfs read. Keep the real CLI, clock, driver,
        # kernel reads, logs and positive waits; do not fabricate an exit result.
        wrapper = """
import runpy, sys, time
namespace = runpy.run_path(sys.argv[1], run_name='deadline_fixture')
original_read = namespace['bounded_read']
reads = 0
def kernel_read(path, *args, **kwargs):
    global reads
    if str(path) == '/proc/meminfo':
        reads += 1
        if reads > 1:
            time.sleep(0.35)
    return original_read(path, *args, **kwargs)
namespace['main'].__globals__['bounded_read'] = kernel_read
sys.argv = sys.argv[1:]
sys.exit(namespace['main']())
"""
        command = self.command(
            output,
            "import time; print('owned-driver-ready',flush=True); time.sleep(0.18)",
            "--duration-seconds",
            "0.1",
        )
        result = subprocess.run(
            [sys.executable, "-c", wrapper, *command[1:]],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        report = json.loads((output / "report.json").read_text())
        self.assertEqual(result.returncode, 1, (result.stdout, result.stderr))
        self.assertTrue(report["timed_out"], report)
        self.assertFalse(report["success"])
        self.assertTrue(report["driver_wait_confirmed"])
        self.assertTrue(report["cleanup_confirmed"])
        self.assertEqual(report["remaining_children"], [])
        self.assertFalse(report["calibrated"])
        self.assertFalse(report["native_vm_exit_confirmed"])

    def test_inventory_read_failure_still_stops_and_waits_owned_driver(self):
        output = self.root / "inventory-failure"
        # Fail only the external children read after the real driver is ready.
        # Keep the CLI, clock, files, captured generation, signal and wait real.
        wrapper = """
import os, runpy, signal, sys
from pathlib import Path
namespace = runpy.run_path(sys.argv[1], run_name='inventory_fixture')
original_read = namespace['bounded_read']
output = Path(sys.argv[sys.argv.index('--output') + 1])
def kernel_read(path, *args, **kwargs):
    path = str(path)
    if (path.endswith('/children') and '/task/' in path
            and not path.startswith(f'/proc/{os.getpid()}/')
            and (output / 'driver-ready').exists()):
        raise OSError(5, 'injected procfs inventory failure')
    return original_read(path, *args, **kwargs)
namespace['main'].__globals__['bounded_read'] = kernel_read
sys.argv = sys.argv[1:]
try:
    sys.exit(namespace['main']())
finally:
    # The red case must not leak its one real child. This harness cleanup
    # cannot alter the collector's already written driver-wait/report result.
    for pid in namespace['child_pids'](os.getpid()):
        identity = namespace['process_identity'](pid)
        if identity is not None and identity[2] == os.getpid():
            namespace['signal_owned']({pid: identity[0]}, signal.SIGTERM)
            os.waitpid(pid, 0)
"""
        program = """
import signal, sys, time
from pathlib import Path
def stop(_signal, _frame):
    Path('driver-stopped').write_text('term-received')
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
Path('driver-ready').touch()
time.sleep(5)
sys.exit(3)
"""
        command = self.command(output, program)
        result = subprocess.run(
            [sys.executable, "-c", wrapper, *command[1:]],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        report = json.loads((output / "report.json").read_text())
        self.assertEqual(result.returncode, 1, (result.stdout, result.stderr))
        self.assertTrue(report["driver_wait_confirmed"], report)
        self.assertEqual(report["driver_exit_code"], 0)
        self.assertEqual(report["remaining_children"], [])
        self.assertTrue((output / "driver-stopped").exists())
        self.assertTrue(report["errors"])
        self.assertFalse(report["cleanup_confirmed"])
        self.assertFalse(report["success"])
        self.assertFalse(report["calibrated"])
        self.assertFalse(report["native_vm_exit_confirmed"])

    def test_uncertain_cleanup_cannot_drain_a_live_producer_until_it_exits(self):
        output = self.root / "uncertain-pipe-drain"
        # Fail only external driver identity reads; a real pipe producer remains
        # unconfirmed. Slow real nonblocking reads so it can refill each chunk.
        wrapper = """
import os, runpy, signal, sys, time
namespace = runpy.run_path(sys.argv[1], run_name='pipe_drain_fixture')
original_read = namespace['bounded_read']
original_pipe_read = os.read
def kernel_read(path, *args, **kwargs):
    parts = str(path).split('/')
    if (len(parts) == 4 and parts[1] == 'proc' and parts[2].isdigit()
            and parts[3] == 'stat' and int(parts[2]) != os.getpid()):
        raise OSError(5, 'injected driver identity read failure')
    return original_read(path, *args, **kwargs)
def pipe_read(fd, count):
    if not os.get_blocking(fd):
        time.sleep(0.005)
    return original_pipe_read(fd, count)
namespace['main'].__globals__['bounded_read'] = kernel_read
os.read = pipe_read
sys.argv = sys.argv[1:]
try:
    sys.exit(namespace['main']())
finally:
    # Independent post-report cleanup, using real identity/PPID/pidfd/wait.
    # It cannot repair the collector's serialized uncertainty or liveness result.
    namespace['main'].__globals__['bounded_read'] = original_read
    os.read = original_pipe_read
    for pid in namespace['child_pids'](os.getpid()):
        identity = namespace['process_identity'](pid)
        if identity is not None and identity[2] == os.getpid():
            namespace['signal_owned']({pid: identity[0]}, signal.SIGTERM)
            os.waitpid(pid, 0)
"""
        program = """
import os, signal
from pathlib import Path
def emergency(_signal, _frame):
    Path('driver-emergency-exit').touch()
    os._exit(3)
signal.signal(signal.SIGALRM, emergency)
signal.setitimer(signal.ITIMER_REAL, 3)
try:
    while True:
        os.write(1, b'x' * 65536)
except BrokenPipeError:
    pass
"""
        command = self.command(output, program, "--max-log-bytes", "1024")
        result = subprocess.run(
            [sys.executable, "-c", wrapper, *command[1:]],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        report = json.loads((output / "report.json").read_text())
        self.assertEqual(result.returncode, 1, (result.stdout, result.stderr))
        self.assertFalse((output / "driver-emergency-exit").exists(), report)
        self.assertFalse(report["driver_wait_confirmed"])
        self.assertFalse(report["cleanup_confirmed"])
        self.assertFalse(report["success"])
        self.assertTrue(report["logs_truncated"])
        self.assertTrue(report["errors"])
        self.assertLessEqual((output / "stdout.log").stat().st_size, 1024)
        self.assertFalse(report["calibrated"])
        self.assertFalse(report["native_vm_exit_confirmed"])

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

    def test_foreign_owned_output_parent_rejected_before_launch(self):
        parent = self.root / "foreign-owner"
        parent.mkdir()
        # Control only external UID/mode facts; execute the real CLI and files.
        wrapper = """
import os, runpy, sys
from pathlib import Path
parent = Path(sys.argv[1])
mode = int(sys.argv[2])
original_stat = Path.stat
def kernel_stat(path, *args, **kwargs):
    result = original_stat(path, *args, **kwargs)
    if path == parent and kwargs.get('follow_symlinks', True):
        fields = list(result)
        fields[0] = mode
        fields[4] = os.geteuid() + 1
        return os.stat_result(fields)
    return result
Path.stat = kernel_stat
sys.argv = sys.argv[3:]
runpy.run_path(sys.argv[0], run_name='__main__')
"""
        for mode in (0o40755, 0o41777):
            with self.subTest(mode=oct(mode)):
                output = parent / f"output-{mode:o}"
                marker = self.root / f"launched-{mode:o}"
                command = self.command(output, f"open({str(marker)!r},'w').close()")
                result = subprocess.run(
                    [
                        sys.executable,
                        "-c",
                        wrapper,
                        str(parent),
                        str(mode),
                        *command[1:],
                    ],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    check=False,
                )
                self.assertEqual(result.returncode, 1, (result.stdout, result.stderr))
                self.assertIn("owned by another user", result.stderr)
                self.assertFalse(marker.exists())
                self.assertFalse(output.exists())

    def test_nonfinite_metadata_rejected_before_fixture_launch(self):
        # NaN/Infinity are Python JSON extensions; a huge valid exponent also
        # overflows its float decoder. None may become a non-JSON report.
        for index, value in enumerate(
            ("NaN", "Infinity", "-Infinity", "1e999", "-1e999")
        ):
            with self.subTest(value=value):
                self.metadata.write_text('{"observed_ratio":' + value + "}")
                output = self.root / f"nonfinite-{index}"
                marker = self.root / f"launched-{index}"
                result = subprocess.run(
                    self.command(output, f"open({str(marker)!r},'w').close()"),
                    capture_output=True,
                    text=True,
                    timeout=5,
                    check=False,
                )
                self.assertEqual(result.returncode, 1, (result.stdout, result.stderr))
                self.assertFalse(marker.exists())
                self.assertFalse(output.exists())

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

    def test_recycled_child_pid_cannot_be_adopted_from_an_old_children_list(self):
        collector = os.getpid()
        parent = 123456
        recycled = 123457
        identities = {
            collector: (1, "S", 0),
            parent: (2, "S", collector),
            recycled: (3, "S", 42),  # Now belongs to an unrelated parent.
        }
        for children, expected in (
            ({collector: [recycled]}, {}),
            ({collector: [parent], parent: [recycled]}, {parent: 2}),
        ):
            with (
                self.subTest(children=children),
                unittest.mock.patch.object(
                    MODULE,
                    "child_pids",
                    side_effect=lambda pid, children=children: list(
                        children.get(pid, [])
                    ),
                ),
                unittest.mock.patch.object(
                    MODULE, "process_identity", side_effect=identities.get
                ),
            ):
                owned = {}
                MODULE.discover_owned(owned)
                self.assertEqual(owned, expected)

    def test_recycled_parent_generation_cannot_authorize_a_child(self):
        collector = os.getpid()
        parent = 123456
        child = 123457
        parent_reads = iter([(2, "S", collector), (2, "S", collector), (4, "S", 42)])

        def identity(pid):
            if pid == parent:
                return next(parent_reads)
            return {collector: (1, "S", 0), child: (3, "S", parent)}.get(pid)

        with (
            unittest.mock.patch.object(
                MODULE,
                "child_pids",
                side_effect=lambda pid: {collector: [parent], parent: [child]}.get(
                    pid, []
                ),
            ),
            unittest.mock.patch.object(
                MODULE, "process_identity", side_effect=identity
            ),
        ):
            owned = {}
            MODULE.discover_owned(owned)
            self.assertEqual(owned, {parent: 2})

    def test_total_generation_inventory_is_bounded_before_registration(self):
        collector = os.getpid()
        driver, child = 123456, 123457
        # Churn can fill the historical inventory while only the driver is live.
        owned = {driver: 2}
        owned.update(
            (pid, 1) for pid in range(200000, 200000 + MODULE.MAX_CHILDREN - 1)
        )
        initial = dict(owned)
        identities = {
            collector: (1, "S", 0),
            driver: (2, "S", collector),
            child: (3, "S", driver),
        }
        children = {collector: [driver], driver: []}
        with (
            unittest.mock.patch.object(
                MODULE, "child_pids", side_effect=lambda pid: children.get(pid, [])
            ),
            unittest.mock.patch.object(
                MODULE, "process_identity", side_effect=identities.get
            ),
        ):
            # Existing generations remain discoverable at exactly the limit.
            MODULE.discover_owned(owned)
            self.assertEqual(owned, initial)
            children[driver] = [child]
            with self.assertRaisesRegex(
                ValueError, "fixture descendant bound exceeded"
            ):
                MODULE.discover_owned(owned)
            self.assertEqual(owned, initial)
            self.assertNotIn(child, owned)

    def test_disappearing_process_stat_does_not_invent_residency(self):
        for error in (FileNotFoundError, ProcessLookupError):
            with self.subTest(error=error), unittest.mock.patch.object(
                MODULE, "bounded_read", side_effect=error
            ):
                self.assertIsNone(MODULE.process_identity(123))
                value = MODULE.residency(123, 1)
                self.assertEqual(value["residency_state"], "unavailable")
                self.assertEqual(value["residency_reason"], "identity_missing")
                self.assertIsNone(value["rss_bytes"])
                self.assertIsNone(value["pss_bytes"])
                self.assertIsNone(value["exit_observed_monotonic_ns"])

    def test_disappearing_task_keeps_other_threads_children(self):
        tasks = self.root / "tasks"
        tasks.mkdir()
        for tid in (1, 2):
            (tasks / str(tid)).mkdir()
        real_scandir = os.scandir

        def read_children(path, limit):
            if Path(path).parent.name == "1":
                raise ProcessLookupError
            return b"123 456\n"

        with (
            unittest.mock.patch.object(
                MODULE.os, "scandir", side_effect=lambda path: real_scandir(tasks)
            ),
            unittest.mock.patch.object(
                MODULE, "bounded_read", side_effect=read_children
            ),
        ):
            self.assertEqual(MODULE.child_pids(123), [123, 456])

    def test_disappearing_task_directory_keeps_captured_ownership(self):
        owned = {123: 456}
        with (
            unittest.mock.patch.object(
                MODULE.os, "scandir", side_effect=ProcessLookupError
            ),
            unittest.mock.patch.object(
                MODULE, "process_identity", return_value=(1, "S", 0)
            ),
        ):
            MODULE.discover_owned(owned)
        self.assertEqual(owned, {123: 456})

    def test_unexpected_process_read_errors_still_fail_closed(self):
        with unittest.mock.patch.object(
            MODULE, "bounded_read", side_effect=PermissionError
        ):
            with self.assertRaises(PermissionError):
                MODULE.process_identity(123)
            with self.assertRaises(PermissionError):
                MODULE.child_pids(os.getpid())

    def test_pid_generation_change_discards_residency(self):
        with (
            unittest.mock.patch.object(
                MODULE, "process_identity", side_effect=[(1, "R"), (2, "R")]
            ),
            unittest.mock.patch.object(
                MODULE, "bounded_read", return_value=b"Rss: 10 kB\nPss: 8 kB\n"
            ),
        ):
            value = MODULE.residency(123, 1)
            self.assertEqual(value["residency_reason"], "identity_raced")
            self.assertIsNone(value["rss_bytes"])
            self.assertIsNone(value["exit_observed_monotonic_ns"])


class ResidencyEvidenceTests(unittest.TestCase):
    @staticmethod
    def stat(generation=1, state="S"):
        return f"123 (fixture) {state} 1 {'0 ' * 17}{generation}".encode()

    def test_external_read_failures_have_distinct_reasons_without_exit_or_zero(self):
        for reason in ("permission_denied", "smaps_missing", "smaps_incomplete", "zombie", "identity_changed"):
            with self.subTest(reason=reason):
                def read(path, limit=65536):
                    if str(path).endswith("/stat"):
                        return self.stat(2 if reason == "identity_changed" else 1,
                                         "Z" if reason == "zombie" else "S")
                    if reason == "permission_denied":
                        raise PermissionError("controlled external smaps refusal")
                    if reason == "smaps_missing":
                        raise FileNotFoundError("controlled external smaps disappearance")
                    return b"Rss: 10 kB\n"

                with unittest.mock.patch.object(MODULE, "bounded_read", side_effect=read):
                    value = MODULE.residency(123, 1)
                self.assertEqual(value["residency_state"], "unavailable")
                self.assertEqual(value["residency_reason"], reason)
                self.assertIsNone(value["rss_bytes"])
                self.assertIsNone(value["pss_bytes"])
                self.assertIsNone(value["exit_observed_monotonic_ns"])

    def test_ambiguous_disappearance_cannot_become_positive_exit(self):
        observer = MODULE.ResidencyObserver()
        try:
            with unittest.mock.patch.object(MODULE, "bounded_read", side_effect=ProcessLookupError):
                value = observer.sample(123, 1)
            self.assertEqual(value["residency_state"], "unavailable")
            self.assertEqual(value["residency_reason"], "identity_missing")
            self.assertIsNone(value["exit_observed_monotonic_ns"])
        finally:
            observer.close()

    def test_pidfd_generation_race_cannot_certify_the_wrong_process_exit(self):
        with subprocess.Popen([sys.executable, "-c", "pass"]) as child:
            fd = os.pidfd_open(child.pid)
            child.wait(timeout=5)
            duplicate = os.dup(fd)
            observer = MODULE.ResidencyObserver()
            reads = iter([self.stat(1), self.stat(2), self.stat(2)])
            try:
                with (
                    unittest.mock.patch.object(MODULE.os, "pidfd_open", return_value=duplicate),
                    unittest.mock.patch.object(MODULE, "bounded_read", side_effect=lambda *args: next(reads)),
                ):
                    value = observer.sample(123, 1)
                self.assertEqual(value["residency_state"], "unavailable")
                self.assertEqual(value["residency_reason"], "identity_changed")
                self.assertIsNone(value["exit_observed_monotonic_ns"])
                with self.assertRaises(OSError):
                    os.fstat(duplicate)
            finally:
                observer.close()
                os.close(fd)

    def test_observation_descriptors_retire_without_terminating_the_owned_process(self):
        with subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read(1)"], stdin=subprocess.PIPE) as child:
            observer = MODULE.ResidencyObserver()
            try:
                generation = MODULE.process_identity(child.pid)[0]
                before = len(os.listdir("/proc/self/fd"))
                value = observer.sample(child.pid, generation)
                self.assertEqual(value["residency_state"], "measured")
                self.assertEqual(len(os.listdir("/proc/self/fd")), before + 1)
                observer.close()
                self.assertEqual(len(os.listdir("/proc/self/fd")), before)
                self.assertIsNone(child.poll())
            finally:
                observer.close()
                child.stdin.close()
                child.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
