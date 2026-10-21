"""Real owned files/processes and original-record consumers, without test sleeps."""

import copy
import hashlib
import json
import os
import resource
import select
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import contextmanager
from pathlib import Path

from file_open_permission import EVENT, FileOpenPermission
from file_open_permission_probe import PAYLOAD, join, producer, qualify
from file_open_permission_report import validate

HERE = Path(__file__).resolve().parent
SOURCE = "a" * 40
KERNEL_ENABLED = os.environ.get("OKOU_TEST_OPEN_PERMISSION_KERNEL") == "1"


class InputTests(unittest.TestCase):
    def test_original_identity_rejection_preserves_borrowed_fd(self):
        with tempfile.TemporaryFile() as stream:
            value = os.fstat(stream.fileno())
            with self.assertRaisesRegex(ValueError, "foreign original"):
                FileOpenPermission(stream.fileno(), (value.st_dev, value.st_ino + 1))
            stream.write(b"borrower still owns this descriptor")
            stream.seek(0)
            self.assertEqual(stream.read(), b"borrower still owns this descriptor")

    def test_non_regular_input_is_rejected_without_marking(self):
        read, write = os.pipe()
        try:
            value = os.fstat(read)
            with self.assertRaisesRegex(ValueError, "regular file"):
                FileOpenPermission(read, (value.st_dev, value.st_ino))
            os.write(write, b"still owned")
            self.assertEqual(os.read(read, 20), b"still owned")
        finally:
            os.close(read)
            os.close(write)

    def test_probe_cli_refuses_existing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "existing"
            marker.write_bytes(b"preserve")
            result = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(HERE / "file_open_permission_probe.py"),
                    "--output-dir",
                    directory,
                    "--source-commit",
                    SOURCE,
                ],
                check=False,
                capture_output=True,
                timeout=10,
            )
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertEqual(marker.read_bytes(), b"preserve")
            self.assertFalse((Path(directory) / "record.json").exists())

    def test_report_cli_refuses_untrusted_capture(self):
        with tempfile.TemporaryDirectory() as directory:
            record = Path(directory) / "record.json"
            record.write_bytes(b'{"complete":true}')
            result = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(HERE / "file_open_permission_report.py"),
                    str(record),
                    "--expected-source",
                    SOURCE,
                    "--expected-capture-sha256",
                    "0" * 64,
                    "--expected-directory",
                    directory,
                ],
                check=False,
                capture_output=True,
                timeout=10,
            )
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn(b"capture digest mismatch", result.stderr)
            self.assertEqual(result.stdout, b"")

    def test_report_cli_refuses_fifo_without_waiting_for_a_writer(self):
        with tempfile.TemporaryDirectory() as directory:
            record = Path(directory) / "record.json"
            os.mkfifo(record)
            result = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(HERE / "file_open_permission_report.py"),
                    str(record),
                    "--expected-source",
                    SOURCE,
                    "--expected-capture-sha256",
                    "0" * 64,
                    "--expected-directory",
                    directory,
                ],
                check=False,
                capture_output=True,
                timeout=10,
            )
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn(b"invalid original file", result.stderr)


@unittest.skipUnless(
    KERNEL_ENABLED,
    "explicit privileged kernel suite: OKOU_TEST_OPEN_PERMISSION_KERNEL=1",
)
class KernelTests(unittest.TestCase):
    @contextmanager
    def fixture(self):
        self.assertEqual(os.geteuid(), 0, "privileged suite must actually run as root")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "original"
            path.write_bytes(PAYLOAD)
            with path.open("rb") as stream:
                value = os.fstat(stream.fileno())
                gate = FileOpenPermission(stream.fileno(), (value.st_dev, value.st_ino))
                children = []
                state = {"closed": False}
                try:
                    yield path, stream, gate, children, state
                finally:
                    try:
                        if not state["closed"]:
                            gate.close()
                    finally:
                        for child in children:
                            try:
                                child.communicate(timeout=10)
                            except subprocess.TimeoutExpired:
                                child.kill()
                                child.communicate(timeout=10)
                                self.fail(
                                    "fixture-owned producer needed emergency intervention"
                                )

    def start(self, path, children):
        child = producer(path)
        children.append(child)
        return child

    def test_real_allow_then_deny_and_one_time_disposition(self):
        with self.fixture() as (path, stream, gate, children, _):
            for allow in (True, False):
                child = self.start(path, children)
                event = gate.receive()
                self.assertEqual(event.pid, child.pid)
                self.assertIsNone(child.poll())
                disposition = gate.decide(event, allow)
                self.assertTrue(disposition["event_descriptors_closed"])
                kernel_fields = EVENT.unpack(bytes.fromhex(event.raw_hex))
                for descriptor in (kernel_fields[5], kernel_fields[-1]):
                    with self.assertRaises(OSError):
                        os.fstat(descriptor)
                with self.assertRaisesRegex(ValueError, "completed permission"):
                    gate.decide(event, allow)
                result = join(child)
                expected = {"payload_hex": PAYLOAD.hex()} if allow else {"errno": 1}
                self.assertEqual(
                    json.loads(bytes.fromhex(result["stdout_hex"])), expected
                )
                self.assertEqual(result["exit"], 0 if allow else 23)
            self.assertEqual(os.pread(stream.fileno(), len(PAYLOAD), 0), PAYLOAD)

    def test_multiple_original_producers_keep_independent_pending_owners(self):
        with self.fixture() as (path, _, gate, children, _):
            first = self.start(path, children)
            second = self.start(path, children)
            events = [gate.receive(), gate.receive()]
            self.assertEqual({event.pid for event in events}, {first.pid, second.pid})
            self.assertIsNone(first.poll())
            self.assertIsNone(second.poll())
            for event in reversed(events):
                gate.decide(event, event.pid == first.pid)
            self.assertEqual(join(first)["exit"], 0)
            self.assertEqual(join(second)["exit"], 23)

    def test_kernel_pidfd_above_select_descriptor_limit(self):
        before = resource.getrlimit(resource.RLIMIT_NOFILE)
        self.assertTrue(before[1] == resource.RLIM_INFINITY or before[1] >= 1200)
        resource.setrlimit(resource.RLIMIT_NOFILE, (max(before[0], 1200), before[1]))
        try:
            with self.fixture() as (path, stream, gate, children, _):
                padding = []
                try:
                    while not padding or padding[-1] < 1100:
                        padding.append(os.dup(stream.fileno()))
                    child = self.start(path, children)
                    event = gate.receive()
                    self.assertGreater(
                        EVENT.unpack(bytes.fromhex(event.raw_hex))[-1], 1023
                    )
                    self.assertEqual(event.pid, child.pid)
                    gate.decide(event, True)
                    self.assertEqual(join(child)["exit"], 0)
                finally:
                    for descriptor in padding:
                        os.close(descriptor)
        finally:
            resource.setrlimit(resource.RLIMIT_NOFILE, before)

    def test_write_truncate_open_is_held_before_original_bytes_change(self):
        code = """import json,pathlib,sys
try:
    pathlib.Path(sys.argv[1]).write_bytes(b'timezone after release\\n')
except OSError as error:
    print(json.dumps({'errno':error.errno}),flush=True)
    sys.exit(23)
print(json.dumps({'written':True}),flush=True)
"""
        with self.fixture() as (path, stream, gate, children, _):
            for allow in (False, True):
                child = subprocess.Popen(
                    [sys.executable, "-B", "-c", code, str(path)],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                children.append(child)
                event = gate.receive()
                self.assertEqual(event.pid, child.pid)
                self.assertIsNone(child.poll())
                self.assertEqual(os.pread(stream.fileno(), len(PAYLOAD), 0), PAYLOAD)
                gate.decide(event, allow)
                self.assertEqual(join(child)["exit"], 0 if allow else 23)
            self.assertEqual(
                os.pread(stream.fileno(), len(PAYLOAD), 0), b"timezone after release\n"
            )

    def test_retirement_explicitly_denies_unobserved_queued_event(self):
        with self.fixture() as (path, stream, gate, children, state):
            child = self.start(path, children)
            self.assertTrue(select.select([gate], [], [], 10)[0])
            cleanup = gate.close()
            state["closed"] = True
            self.assertEqual(len(cleanup["denied"]), 1)
            self.assertEqual(cleanup["denied"][0]["event"]["pid"], child.pid)
            self.assertEqual(join(child)["exit"], 23)
            with self.assertRaisesRegex(ValueError, "closed"):
                gate.close()
            self.assertEqual(os.pread(stream.fileno(), len(PAYLOAD), 0), PAYLOAD)

    def test_observer_unwind_denies_retained_original_event(self):
        with self.fixture() as (path, _, gate, children, state):
            with self.assertRaisesRegex(RuntimeError, "observer lost"), gate:
                child = self.start(path, children)
                self.assertEqual(gate.receive().pid, child.pid)
                raise RuntimeError("observer lost")
            state["closed"] = True
            self.assertEqual(join(child)["exit"], 23)

    def test_original_rename_does_not_mark_replacement_or_lose_original(self):
        with self.fixture() as (path, _, gate, children, _):
            moved = path.with_name("moved-original")
            path.rename(moved)
            path.write_bytes(b"replacement is a different inode")
            replacement = self.start(path, children)
            self.assertEqual(join(replacement)["exit"], 0)
            child = self.start(moved, children)
            event = gate.receive()
            self.assertEqual(event.pid, child.pid)
            gate.decide(event, True)
            self.assertEqual(
                json.loads(bytes.fromhex(join(child)["stdout_hex"])),
                {"payload_hex": PAYLOAD.hex()},
            )

    def test_gate_retains_original_after_borrower_closes_its_fd(self):
        with self.fixture() as (path, stream, gate, children, _):
            stream.close()
            child = self.start(path, children)
            event = gate.receive()
            self.assertEqual(event.pid, child.pid)
            gate.decide(event, True)
            self.assertEqual(join(child)["exit"], 0)

    def test_creator_thread_and_foreign_event_cannot_dispose_original(self):
        with self.fixture() as (path, _, gate, children, _):
            child = self.start(path, children)
            event = gate.receive()
            errors = []

            def foreign():
                try:
                    gate.decide(event, True)
                except ValueError as error:
                    errors.append(str(error))

            thread = threading.Thread(target=foreign)
            thread.start()
            thread.join(timeout=10)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, ["foreign gate owner"])
            with self.assertRaisesRegex(ValueError, "foreign or completed"):
                gate.decide(copy.copy(event), True)
            self.assertIsNone(child.poll())
            gate.decide(event, False)
            self.assertEqual(join(child)["exit"], 23)

    def test_real_qualification_and_original_cli_replay_reject_corruption(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "qualification"
            capture = qualify(output, SOURCE)
            raw = (output / "record.json").read_bytes()
            self.assertEqual(
                validate(raw, SOURCE, capture, str(output))["original_cases"], 3
            )
            command = [
                sys.executable,
                "-B",
                str(HERE / "file_open_permission_report.py"),
                str(output / "record.json"),
                "--expected-source",
                SOURCE,
                "--expected-capture-sha256",
                capture,
                "--expected-directory",
                str(output),
            ]
            result = subprocess.run(
                command, check=False, capture_output=True, timeout=10
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            original = json.loads(raw)
            mutations = [
                lambda v: v["claims"].update(native_guest_executed=True),
                lambda v: v.update(source_commit="b" * 40),
                lambda v: v["cases"][0]["cleanup"].update(group_closed=False),
                lambda v: v["cases"][0]["cleanup"].update(observation_failed=True),
                lambda v: v["cases"][1]["producer"].update(exit=0),
                lambda v: v["cases"][0]["disposition"]["event"].update(
                    inode=v["original"]["inode"] + 1
                ),
                lambda v: v["cases"][2]["cleanup"].update(denied=[]),
                lambda v: v["cases"][0]["disposition"].update(
                    response_completed_ns=v["completed_ns"] + 1
                ),
                lambda v: v["cases"][0]["disposition"]["event"].update(
                    pid=v["controller"]["pid"]
                ),
            ]
            for mutate in mutations:
                changed = copy.deepcopy(original)
                mutate(changed)
                bad = json.dumps(changed).encode()
                with self.assertRaises(ValueError):
                    validate(bad, SOURCE, hashlib.sha256(bad).hexdigest(), str(output))
            with self.assertRaisesRegex(ValueError, "invocation"):
                validate(raw, SOURCE, capture, str(output) + "-another")


if __name__ == "__main__":
    unittest.main()
