"""Directory outcomes on real owned processes; synthetic records are reader tests only."""

import copy
import hashlib
import json
import os
import select
import stat
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from file_open_permission import EVENT, FAN_ONDIR, FAN_OPEN_PERM, FileOpenPermission
from file_open_permission_probe import CLAIMS, PAYLOAD, join, producer, qualify
from file_open_permission_report import validate

HERE = Path(__file__).resolve().parent
SOURCE = "a" * 40
KERNEL_ENABLED = os.environ.get("OKOU_TEST_OPEN_PERMISSION_KERNEL") == "1"


def synthetic_record():
    """A bounded semantic-consumer input, never evidence of kernel execution."""
    original = {
        "device": 11,
        "inode": 37,
        "uid": 1000,
        "size": 4096,
        "links": 2,
        "mtime_ns": 1,
        "ctime_ns": 1,
        "file_type": stat.S_IFDIR,
    }
    child = {
        "device": 11,
        "inode": 38,
        "uid": 1000,
        "size": len(PAYLOAD),
        "links": 1,
        "mtime_ns": 1,
        "ctime_ns": 1,
    }
    cases = []
    for index, kind in enumerate(("allow", "deny", "retire")):
        start, pid = 2000 + index * 1000, 300 + index
        disposition = {
            "event": {
                "raw_hex": EVENT.pack(
                    32, 3, 0, 24, FAN_OPEN_PERM, 7, pid, 4, 0, 8, 8
                ).hex(),
                "device": 11,
                "inode": 37,
                "pid": pid,
                "observed_ns": start + 10,
            },
            "decision": "allow" if kind == "allow" else "deny",
            "response_started_ns": start + 11,
            "response_completed_ns": start + 12,
            "event_descriptors_closed": True,
        }
        result = {
            "directory": {
                key: original[key] for key in ("device", "inode", "file_type")
            },
            "child": {"device": 11, "inode": 38},
            "payload_hex": PAYLOAD.hex(),
        }
        if kind != "allow":
            result = {"errno": 1}
        cases.append(
            {
                "kind": kind,
                "started_ns": start,
                "producer_pid": pid,
                "disposition": disposition,
                "producer": {
                    "pid": pid,
                    "exit": 0 if kind == "allow" else 23,
                    "stdout_hex": json.dumps(result).encode().hex(),
                    "stderr_hex": "",
                    "joined_ns": start + 30,
                },
                "cleanup": {
                    "started_ns": start + (5 if kind == "retire" else 31),
                    "completed_ns": start + (15 if kind == "retire" else 32),
                    "denied": [disposition] if kind == "retire" else [],
                    "mark_removed": True,
                    "group_closed": True,
                    "original_duplicate_closed": True,
                    "observation_failed": False,
                },
                "completed_ns": start + 40,
            }
        )
    return {
        "schema": "original-directory-open-permission-v1",
        "mark_mask": FAN_OPEN_PERM | FAN_ONDIR,
        "source_commit": SOURCE,
        "run_id": "10000000-0000-4000-8000-000000000001",
        "host": {
            "boot_id": "10000000-0000-4000-8000-000000000002",
            "kernel": "synthetic-reader-input",
        },
        "controller": {"pid": 222, "task": [222, 1], "uid": 1000},
        "invocation": [
            sys.executable,
            str(HERE / "file_open_permission_probe.py"),
            "--output-dir",
            "/owned/qualification",
            "--source-commit",
            SOURCE,
            "--directory",
        ],
        "started_ns": 1000,
        "completed_ns": 10000,
        "payload_sha256": hashlib.sha256(PAYLOAD).hexdigest(),
        "cases": cases,
        "claims": CLAIMS.copy(),
        "error": None,
        "complete": True,
        "original": original,
        "child": child,
        "borrowed_original_closed": True,
    }


def replay(value, *, original_directory=True):
    raw = json.dumps(value).encode()
    return validate(
        raw,
        SOURCE,
        hashlib.sha256(raw).hexdigest(),
        "/owned/qualification",
        original_directory=original_directory,
    )


class InputAndReaderTests(unittest.TestCase):
    def test_directory_selection_rejects_other_types_and_preserves_borrowers(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            tempfile.TemporaryFile() as file,
        ):
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
            try:
                for borrowed, select_directory, error in (
                    (fd, False, "regular file"),
                    (file.fileno(), True, "directory"),
                    (fd, 1, "boolean"),
                ):
                    value = os.fstat(borrowed)
                    with self.subTest(directory=select_directory, error=error):
                        with self.assertRaisesRegex(ValueError, error):
                            FileOpenPermission(
                                borrowed,
                                (value.st_dev, value.st_ino),
                                directory=select_directory,
                            )
                        self.assertEqual(os.fstat(borrowed).st_ino, value.st_ino)
            finally:
                os.close(fd)

    def test_directory_record_requires_explicit_reader_selection(self):
        original = synthetic_record()
        self.assertEqual(replay(original)["original_cases"], 3)
        with self.assertRaises(ValueError):
            replay(original, original_directory=False)

    def test_directory_reader_rejects_foreign_authority_and_incomplete_results(self):
        original = synthetic_record()

        def wrong_mask(value):
            event = value["cases"][0]["disposition"]["event"]
            raw = list(EVENT.unpack(bytes.fromhex(event["raw_hex"])))
            raw[4] = FAN_OPEN_PERM | FAN_ONDIR
            event["raw_hex"] = EVENT.pack(*raw).hex()

        def wrong_producer_type(value, owner, key):
            producer = value["cases"][0]["producer"]
            result = json.loads(bytes.fromhex(producer["stdout_hex"]))
            result[owner][key] = float(result[owner][key])
            producer["stdout_hex"] = json.dumps(result).encode().hex()

        mutations = (
            wrong_mask,
            lambda v: v.update(mark_mask=FAN_OPEN_PERM),
            lambda v: v["original"].update(file_type=stat.S_IFREG),
            lambda v: v["cases"][0]["disposition"]["event"].update(inode=38),
            lambda v: v["child"].update(inode=39),
            lambda v: v["claims"].update(native_guest_executed=True),
            lambda v: v["cases"][1]["producer"].update(exit=0),
            lambda v: v["cases"][0]["cleanup"].update(group_closed=False),
            lambda v: v["cases"][2]["cleanup"].update(denied=[]),
            lambda v: v["cases"][0]["disposition"].update(response_completed_ns=10001),
            lambda v: v["invocation"].pop(),
            lambda v: wrong_producer_type(v, "directory", "inode"),
            lambda v: wrong_producer_type(v, "directory", "file_type"),
            lambda v: wrong_producer_type(v, "child", "inode"),
        )
        for index, mutate in enumerate(mutations):
            changed = copy.deepcopy(original)
            mutate(changed)
            with self.subTest(mutation=index), self.assertRaises(ValueError):
                replay(changed)

    def test_real_reader_cli_and_nonoverwriting_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            record = Path(directory) / "record.json"
            raw = json.dumps(synthetic_record()).encode()
            record.write_bytes(raw)
            command = [
                sys.executable,
                "-B",
                str(HERE / "file_open_permission_report.py"),
                str(record),
                "--expected-source",
                SOURCE,
                "--expected-capture-sha256",
                hashlib.sha256(raw).hexdigest(),
                "--expected-directory",
                "/owned/qualification",
            ]
            for flags, expected in (([], 1), (["--directory"], 0)):
                result = subprocess.run(
                    command + flags, capture_output=True, timeout=10, check=False
                )
                self.assertEqual(result.returncode, expected, result.stderr)
            result = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(HERE / "file_open_permission_probe.py"),
                    "--output-dir",
                    directory,
                    "--source-commit",
                    SOURCE,
                    "--directory",
                ],
                capture_output=True,
                timeout=10,
                check=False,
            )
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertEqual(record.read_bytes(), raw)
            record.unlink()
            os.mkfifo(record)
            result = subprocess.run(
                command + ["--directory"], capture_output=True, timeout=10, check=False
            )
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn(b"invalid original file", result.stderr)


@unittest.skipUnless(
    KERNEL_ENABLED,
    "explicit privileged kernel suite: OKOU_TEST_OPEN_PERMISSION_KERNEL=1",
)
class DirectoryKernelTests(unittest.TestCase):
    @contextmanager
    def fixture(self):
        self.assertEqual(os.geteuid(), 0, "privileged suite must actually run as root")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "original"
            path.mkdir(mode=0o700)
            (path / "payload").write_bytes(PAYLOAD)
            (path / "subdirectory").mkdir()
            (path / "subdirectory" / "payload").write_bytes(PAYLOAD)
            outside = Path(directory) / "unrelated"
            outside.mkdir()
            (outside / "payload").write_bytes(PAYLOAD)
            fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
            children, state, gate = [], {"borrowed": fd, "closed": False}, None
            try:
                value = os.fstat(fd)
                gate = FileOpenPermission(
                    fd, (value.st_dev, value.st_ino), directory=True
                )
                yield path, gate, children, state
            finally:
                try:
                    if gate is not None and not state["closed"]:
                        gate.close()
                finally:
                    failures = []
                    for child in children:
                        try:
                            child.communicate(timeout=10)
                        except BaseException as error:  # noqa: BLE001 - join every owned producer
                            failures.append(f"producer {child.pid}: {error}")
                            try:
                                if child.poll() is None:
                                    child.kill()
                                child.communicate(timeout=10)
                            except BaseException as cleanup_error:  # noqa: BLE001 - preserve all cleanup failures
                                failures.append(
                                    f"producer {child.pid} containment: {cleanup_error}"
                                )
                    if state["borrowed"] is not None:
                        os.close(state["borrowed"])
                    self.assertEqual(
                        failures, [], "owned producers needed emergency containment"
                    )

    def start(self, path, children, *, directory=True):
        child = producer(path, directory=directory)
        children.append(child)
        return child

    def test_exact_directory_allow_and_deny_join_real_producers(self):
        with self.fixture() as (path, gate, children, _):
            for allow in (True, False):
                child = self.start(path, children)
                event = gate.receive()
                self.assertEqual(event.pid, child.pid)
                self.assertEqual(
                    EVENT.unpack(bytes.fromhex(event.raw_hex))[4],
                    FAN_OPEN_PERM,
                )
                gate.check_pending_producer(event)
                self.assertIsNone(child.poll())
                self.assertTrue(gate.decide(event, allow)["event_descriptors_closed"])
                result = join(child)
                self.assertEqual(result["exit"], 0 if allow else 23)
                output = json.loads(bytes.fromhex(result["stdout_hex"]))
                if allow:
                    self.assertEqual(output["payload_hex"], PAYLOAD.hex())
                    self.assertEqual(output["directory"]["inode"], event.inode)
                    self.assertEqual(output["directory"]["file_type"], stat.S_IFDIR)
                else:
                    self.assertEqual(output, {"errno": 1})
            self.assertEqual((path / "payload").read_bytes(), PAYLOAD)

    def test_child_and_unrelated_opens_progress_while_original_is_held(self):
        with self.fixture() as (path, gate, children, _):
            held = self.start(path, children)
            event = gate.receive()
            for other, directory in (
                (path / "payload", False),
                (path / "subdirectory", True),
                (path.parent / "unrelated", True),
            ):
                completed = join(self.start(other, children, directory=directory))
                self.assertEqual(completed["exit"], 0)
                self.assertEqual(
                    json.loads(bytes.fromhex(completed["stdout_hex"]))["payload_hex"],
                    PAYLOAD.hex(),
                )
                gate.check_pending_producer(event)
                self.assertIsNone(held.poll())
            gate.decide(event, True)
            self.assertEqual(join(held)["exit"], 0)

    def test_retirement_explicitly_denies_unobserved_directory_open(self):
        with self.fixture() as (path, gate, children, state):
            child = self.start(path, children)
            poller = select.poll()
            poller.register(gate.fileno(), select.POLLIN)
            self.assertEqual(poller.poll(10_000), [(gate.fileno(), select.POLLIN)])
            cleanup = gate.close()
            state["closed"] = True
            self.assertEqual(len(cleanup["denied"]), 1)
            self.assertEqual(cleanup["denied"][0]["event"]["pid"], child.pid)
            self.assertEqual(join(child)["exit"], 23)

    def test_observer_unwind_denies_and_joins_actual_directory_producer(self):
        with self.fixture() as (path, gate, children, state):
            with self.assertRaisesRegex(RuntimeError, "observer lost"), gate:
                child = self.start(path, children)
                self.assertEqual(gate.receive().pid, child.pid)
                raise RuntimeError("observer lost")
            state["closed"] = True
            self.assertEqual(join(child)["exit"], 23)

    def test_renamed_original_stays_owned_after_borrower_closes(self):
        with self.fixture() as (path, gate, children, state):
            moved = path.with_name("moved")
            path.rename(moved)
            path.mkdir()
            (path / "payload").write_bytes(b"replacement")
            os.close(state["borrowed"])
            state["borrowed"] = None
            replacement = join(self.start(path, children))
            self.assertEqual(replacement["exit"], 0)
            self.assertEqual(
                json.loads(bytes.fromhex(replacement["stdout_hex"]))["payload_hex"],
                b"replacement".hex(),
            )
            child = self.start(moved, children)
            event = gate.receive()
            self.assertEqual(event.pid, child.pid)
            gate.decide(event, True)
            result = join(child)
            self.assertEqual(result["exit"], 0)
            self.assertEqual(
                json.loads(bytes.fromhex(result["stdout_hex"]))["payload_hex"],
                PAYLOAD.hex(),
            )

    def test_multiple_directory_events_keep_independent_owners(self):
        with self.fixture() as (path, gate, children, _):
            first = self.start(path, children)
            second = self.start(path, children)
            events = [gate.receive(), gate.receive()]
            self.assertEqual({event.pid for event in events}, {first.pid, second.pid})
            for event in reversed(events):
                with self.assertRaisesRegex(ValueError, "foreign or completed"):
                    gate.decide(copy.copy(event), True)
                gate.decide(event, event.pid == first.pid)
            self.assertEqual(join(first)["exit"], 0)
            self.assertEqual(join(second)["exit"], 23)

    def test_real_directory_qualification_and_original_cli_replay(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "qualification"
            capture = qualify(output, SOURCE, directory=True)
            raw = (output / "record.json").read_bytes()
            self.assertEqual(
                validate(raw, SOURCE, capture, str(output), original_directory=True)[
                    "original_cases"
                ],
                3,
            )
            result = subprocess.run(
                [
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
                    "--directory",
                ],
                capture_output=True,
                timeout=10,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((output / "original" / "payload").read_bytes(), PAYLOAD)


if __name__ == "__main__":
    unittest.main()
