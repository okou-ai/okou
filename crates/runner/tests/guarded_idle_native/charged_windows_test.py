"""Ordinary synthetic-file/CLI refusals; actual kernel qualification is opt-in."""

import copy
import errno
import importlib.util
import json
import os
import selectors
import signal
import subprocess
import sys
import tempfile
import threading
import unittest
import unittest.mock
import uuid
from pathlib import Path

OWNER = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "charged_windows_report", OWNER / "charged_windows_report.py"
)
REPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REPORT)
LIB_SPEC = importlib.util.spec_from_file_location(
    "charged_windows", OWNER / "charged_windows.py"
)
LIB = importlib.util.module_from_spec(LIB_SPEC)
LIB_SPEC.loader.exec_module(LIB)
MIB = 1024 * 1024


class ReplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.shared = tempfile.TemporaryDirectory(prefix="charged-window-original-")
        cls.original_file = Path(cls.shared.name) / "retained.bin"
        with cls.original_file.open("xb") as handle:
            handle.truncate(64 * MIB)
        cls.file_hash = REPORT.sha256(cls.original_file.read_bytes())

    @classmethod
    def tearDownClass(cls):
        cls.shared.cleanup()

    def setUp(self):
        self.work = tempfile.TemporaryDirectory(prefix="charged-window-replay-")
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name)
        os.link(self.original_file, self.root / "retained.bin")
        self.invocation = str(uuid.uuid4())
        self.sources = {}
        for name in REPORT.SOURCES:
            content = (OWNER / name).read_bytes()
            (self.root / name).write_bytes(content)
            self.sources[name] = REPORT.sha256(content)
        self.source_hash = REPORT.sha256(
            json.dumps(self.sources, sort_keys=True, separators=(",", ":")).encode()
        )
        cgroup = "/sys/fs/cgroup/okou-charge-" + self.invocation
        leaf = cgroup + "/counter-1/workload"
        counters = {
            "outer": {
                "group": {"device": 1, "inode": 11},
                "peak": {"device": 1, "inode": 21, "descriptor": 8},
            },
            "inner": {
                "group": {"device": 1, "inode": 12},
                "peak": {"device": 1, "inode": 22, "descriptor": 9},
            },
        }
        self.rows = []
        for index, (name, operation, began, peak, current, file_bytes) in enumerate(
            [
                ("outer", "begin", 1100, 2, 2, 0),
                ("outer", "observe", 1150, 40, 40, 0),
                ("inner", "begin", 1190, 6, 6, 0),
                ("outer", "observe", 1210, 40, 6, 0),
                ("inner", "end", 1250, 24, 6, 0),
                ("outer", "end", 1320, 70, 70, 64),
            ]
        ):
            self.rows.append(
                {
                    "sequence": index,
                    "invocation": self.invocation,
                    "name": name,
                    "operation": operation,
                    "counter": copy.deepcopy(counters[name]),
                    "started_monotonic_ns": began,
                    "completed_monotonic_ns": began + 10,
                    "reset_completed_monotonic_ns": began + 5
                    if operation == "begin"
                    else None,
                    "peak_bytes": peak * MIB,
                    "current_bytes": current * MIB,
                    "file_bytes": file_bytes * MIB,
                }
            )
        worker = {
            "pid": 100,
            "start_ticks": 1000,
            "cgroup": "0::" + leaf.removeprefix("/sys/fs/cgroup"),
        }
        file_id = {"device": 1, "inode": 31, "bytes": 64 * MIB}
        requests = []
        for name, began in [
            ("allocate", 1130),
            ("release", 1170),
            ("transient", 1230),
            ("file", 1270),
            ("exit", 1290),
        ]:
            response = {"completed": name}
            if name == "allocate":
                response["held_bytes"] = 32 * MIB
            if name == "release":
                response["released_bytes"] = 32 * MIB
            if name == "transient":
                response.update(
                    {
                        "child": {
                            "identity": {**worker, "pid": 101, "start_ticks": 1001},
                            "touched_bytes": 16 * MIB,
                        },
                        "child_exit_code": 0,
                        "child_wait_confirmed": True,
                    }
                )
            if name == "file":
                response["file"] = file_id
            requests.append(
                {
                    "command": name,
                    "response": response,
                    "started_monotonic_ns": began,
                    "completed_monotonic_ns": began + 10,
                }
            )
        self.capture = {
            "format": "owned-charged-window-qualification-v1",
            "invocation": self.invocation,
            "source_sha256": self.source_hash,
            "sources": self.sources,
            "boot_id": str(uuid.uuid4()),
            "host": {
                "kernel_release": "synthetic-6.17",
                "architecture": "synthetic",
                "effective_uid": os.geteuid(),
            },
            "parent_identity": {"device": 1, "inode": 10},
            "started_monotonic_ns": 1000,
            "completed_monotonic_ns": 1400,
            "started_unix_ns": 10**18,
            "completed_unix_ns": 10**18 + 400,
            "bounds": dict(REPORT.BOUNDS),
            "parent": "/sys/fs/cgroup",
            "root": cgroup,
            "leaf": leaf,
            "leaf_identity": {"device": 1, "inode": 13},
            "claims": dict(REPORT.CLAIMS),
            "requests": requests,
            "worker": worker,
            "worker_ready_monotonic_ns": 1120,
            "positive_wait_monotonic_ns": 1310,
            "exit_code": 0,
            "wait_confirmed": True,
            "cleanup_intervened": False,
            "cleanup_errors": [],
            "adopted_waits": [],
            "error": None,
            "initial_available_bytes": 12 * 1024**3,
            "final_available_bytes": 12 * 1024**3,
            "retained_file": {**file_id, "sha256": self.file_hash},
            "event_count": 6,
            "stderr_bytes": 0,
            "events_sha256": "",
            "cleanup_records": [],
        }
        for index, (path, inode) in enumerate(
            [(leaf, 13), (cgroup + "/counter-1", 12), (cgroup, 11)]
        ):
            self.capture["cleanup_records"].append(
                {
                    "path": path,
                    "identity": {"device": 1, "inode": inode},
                    "started_monotonic_ns": 1340 + index * 20,
                    "completed_monotonic_ns": 1350 + index * 20,
                    "populated": 0,
                    "processes_empty": True,
                    "removed": True,
                }
            )
        (self.root / "worker.stderr").write_bytes(b"")
        self.save()

    def save(self):
        raw = b"".join(json.dumps(row).encode() + b"\n" for row in self.rows)
        (self.root / "events.jsonl").write_bytes(raw)
        self.capture["events_sha256"] = REPORT.sha256(raw)
        (self.root / "capture.json").write_text(json.dumps(self.capture))

    def replay(self):
        return REPORT.replay(self.root, self.invocation, self.source_hash)

    def test_valid_original_files_replay_with_narrow_claims(self):
        report = self.replay()
        self.assertTrue(report["qualified"])
        self.assertEqual(report["windows"]["inner"]["peak_bytes"], 24 * MIB)
        self.assertEqual(report["post_exit_file_charge_bytes"], 64 * MIB)
        self.assertTrue(all(value is False for value in report["claims"].values()))

    def test_semantic_corruptions_refused_even_with_rehashed_raw_file(self):
        original_capture, original_rows = (
            copy.deepcopy(self.capture),
            copy.deepcopy(self.rows),
        )
        mutations = {
            "missing_end": lambda: self.rows.pop(),
            "replayed_sequence": lambda: self.rows[3].update(sequence=1),
            "foreign_invocation": lambda: self.rows[4].update(
                invocation=str(uuid.uuid4())
            ),
            "same_counter_group": lambda: self.rows[2]["counter"].update(
                group=self.rows[0]["counter"]["group"]
            ),
            "shared_peak_object": lambda: self.rows[2]["counter"].update(
                peak=self.rows[0]["counter"]["peak"]
            ),
            "changed_fd": lambda: self.rows[4]["counter"]["peak"].update(descriptor=19),
            "missing_reset": lambda: self.rows[2].update(
                reset_completed_monotonic_ns=None
            ),
            "unexpected_reset": lambda: self.rows[3].update(
                reset_completed_monotonic_ns=1215
            ),
            "lost_peer_peak": lambda: self.rows[3].update(peak_bytes=6 * MIB),
            "lost_transient": lambda: self.rows[4].update(peak_bytes=7 * MIB),
            "sampled_live_only": lambda: self.rows[4].update(current_bytes=24 * MIB),
            "negative_counter": lambda: self.rows[4].update(peak_bytes=-1),
            "bool_counter": lambda: self.rows[4].update(file_bytes=False),
            "reversed_clock": lambda: self.rows[3].update(completed_monotonic_ns=1200),
            "exit_after_measurement": lambda: self.capture.update(
                positive_wait_monotonic_ns=1390
            ),
            "foreign_worker": lambda: self.capture["worker"].update(cgroup="0::/other"),
            "no_transient_wait": lambda: self.capture["requests"][2]["response"].update(
                child_wait_confirmed=False
            ),
            "wrong_file_inode": lambda: self.capture["retained_file"].update(inode=32),
            "missing_retained_charge": lambda: self.rows[5].update(file_bytes=0),
            "false_empty_group": lambda: self.capture["cleanup_records"][0].update(
                populated=1
            ),
            "wrong_cleanup_order": lambda: self.capture["cleanup_records"].reverse(),
            "intervened": lambda: self.capture.update(cleanup_intervened=True),
            "failed_capture": lambda: self.capture.update(error="original error"),
            "missing_positive_wait": lambda: self.capture.update(wait_confirmed=False),
            "failed_driver": lambda: self.capture.update(exit_code=1),
            "altered_bounds": lambda: self.capture["bounds"].update(
                minimum_available_bytes=1
            ),
            "low_headroom": lambda: self.capture.update(final_available_bytes=1),
            "full_residency": lambda: self.capture["claims"].update(
                relevant_native_residency_complete=True
            ),
            "cold_claim": lambda: self.capture["claims"].update(
                cold_inputs_established=True
            ),
            "native_claim": lambda: self.capture["claims"].update(
                native_guest_executed=True
            ),
            "wrong_held_allocation": lambda: self.capture["requests"][0][
                "response"
            ].update(held_bytes=0),
            "wrong_released_allocation": lambda: self.capture["requests"][1][
                "response"
            ].update(released_bytes=0),
        }
        for name, mutation in mutations.items():
            with self.subTest(name=name):
                self.capture, self.rows = (
                    copy.deepcopy(original_capture),
                    copy.deepcopy(original_rows),
                )
                mutation()
                self.save()
                with self.assertRaises((ValueError, TypeError)):
                    self.replay()

    def test_external_invocation_and_source_binding_are_required(self):
        with self.assertRaises(ValueError):
            REPORT.replay(self.root, str(uuid.uuid4()), self.source_hash)
        with self.assertRaises(ValueError):
            REPORT.replay(self.root, self.invocation, "0" * 64)
        (self.root / "charged_windows_worker.py").write_text("changed original source")
        with self.assertRaises(ValueError):
            self.replay()

    def test_missing_symlinked_truncated_and_corrupt_original_files_refused(self):
        raw = (self.root / "events.jsonl").read_bytes()
        for content in (raw[:-1], b"{}\n", raw + raw[: raw.index(b"\n") + 1]):
            with self.subTest(content=len(content)):
                (self.root / "events.jsonl").write_bytes(content)
                self.capture["events_sha256"] = REPORT.sha256(content)
                (self.root / "capture.json").write_text(json.dumps(self.capture))
                with self.assertRaises(ValueError):
                    self.replay()
        self.save()
        (self.root / "events.jsonl").unlink()
        with self.assertRaises(OSError):
            self.replay()
        (self.root / "events.jsonl").symlink_to(self.root / "capture.json")
        with self.assertRaises(OSError):
            self.replay()

    def test_duplicate_json_fields_refused(self):
        raw = (self.root / "capture.json").read_text()
        (self.root / "capture.json").write_text(raw[:-1] + ',"error":null}')
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.replay()

    def test_fifo_is_refused_without_waiting_for_a_writer(self):
        (self.root / "events.jsonl").unlink()
        os.mkfifo(self.root / "events.jsonl")
        result = subprocess.run(
            [
                sys.executable,
                str(OWNER / "charged_windows_report.py"),
                str(self.root),
                "--invocation",
                self.invocation,
                "--source-sha256",
                self.source_hash,
            ],
            capture_output=True,
            timeout=3,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")

    def test_cli_has_no_success_output_for_invalid_evidence(self):
        self.capture["cleanup_intervened"] = True
        self.save()
        result = subprocess.run(
            [
                sys.executable,
                str(OWNER / "charged_windows_report.py"),
                str(self.root),
                "--invocation",
                self.invocation,
                "--source-sha256",
                self.source_hash,
            ],
            capture_output=True,
            timeout=10,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")

    def test_original_file_hash_mismatch_refused(self):
        self.capture["retained_file"]["sha256"] = "0" * 64
        self.save()
        with self.assertRaisesRegex(ValueError, "file bytes"):
            self.replay()


class SafetyTests(unittest.TestCase):
    @unittest.skipUnless(
        os.environ.get("OKOU_CHARGE_TEST_PARENT"),
        "opt-in real cgroup-v2 setup-failure test",
    )
    def test_live_constructor_metadata_failure_closes_original_peak_fd(self):
        available = next(
            int(line.split()[1]) * 1024
            for line in Path("/proc/meminfo").read_text().splitlines()
            if line.startswith("MemAvailable:")
        )
        self.assertGreaterEqual(available, 8192 * MIB)
        parent = Path(os.environ["OKOU_CHARGE_TEST_PARENT"])
        invocation = str(uuid.uuid4())
        original_fstat = os.fstat
        opened_peak = []

        def metadata_failure(fd):
            if not opened_peak and os.readlink(f"/proc/self/fd/{fd}").endswith(
                "/memory.peak"
            ):
                opened_peak.append(fd)
                raise OSError(errno.EIO, "injected peak metadata failure")
            return original_fstat(fd)

        with (
            unittest.mock.patch.object(os, "fstat", metadata_failure),
            self.assertRaisesRegex(OSError, "injected peak metadata"),
        ):
            LIB.ChargeWindows(parent, ["outer", "inner"], invocation, lambda _: None)
        self.assertEqual(len(opened_peak), 1)
        with self.assertRaises(OSError) as closed:
            original_fstat(opened_peak[0])
        self.assertEqual(closed.exception.errno, errno.EBADF)
        self.assertFalse((parent / ("okou-charge-" + invocation)).exists())

    def test_cancellation_is_not_swallowed_by_a_blocked_selector(self):
        program = """
import os, selectors, signal
from charged_windows_probe import QualificationCancelled, stop
signal.signal(signal.SIGTERM, stop)
r, w = os.pipe()
selector = selectors.DefaultSelector()
selector.register(r, selectors.EVENT_READ)
try:
    print("ready", flush=True)
    selector.select(5)
    raise RuntimeError("cancellation was swallowed")
except QualificationCancelled:
    print("cancelled", flush=True)
finally:
    selector.close()
    os.close(r)
    os.close(w)
"""
        process = subprocess.Popen(
            [sys.executable, "-B", "-c", program],
            cwd=OWNER,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        selector = selectors.DefaultSelector()
        try:
            selector.register(process.stdout, selectors.EVENT_READ)
            self.assertTrue(selector.select(3), "owned selector fixture did not start")
            self.assertEqual(process.stdout.readline(), b"ready\n")
            fd = os.pidfd_open(process.pid)
            try:
                signal.pidfd_send_signal(fd, signal.SIGTERM)
            finally:
                os.close(fd)
            stdout, stderr = process.communicate(timeout=3)
            self.assertEqual(process.returncode, 0, stderr)
            self.assertEqual(stdout, b"cancelled\n")
        finally:
            selector.close()
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=3)
            process.stdout.close()
            process.stderr.close()

    def owner(self):
        owner = LIB.ChargeWindows.__new__(LIB.ChargeWindows)
        owner.owner_pid = os.getpid()
        owner.owner_thread = threading.get_ident()
        owner.states = {"window": "new"}
        owner.closed = False
        owner.failed = False
        owner.peak_files = LIB.ExitStack()
        return owner

    def test_duplicate_reset_and_inactive_window_reads_are_refused(self):
        owner = self.owner()
        for state, operation in [
            ("active", "begin"),
            ("ended", "begin"),
            ("new", "observe"),
            ("ended", "observe"),
            ("new", "end"),
            ("ended", "end"),
        ]:
            with self.subTest(state=state, operation=operation):
                owner.states["window"] = state
                with self.assertRaises(ValueError):
                    getattr(owner, operation)("window")

    def test_other_threads_cannot_reset_or_clean_up_owned_windows(self):
        owner = self.owner()
        failures = []

        def foreign():
            for operation in (lambda: owner.begin("window"), owner.cleanup):
                try:
                    operation()
                except ValueError as error:
                    failures.append(str(error))

        thread = threading.Thread(target=foreign)
        thread.start()
        thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(failures), 2)
        self.assertFalse(owner.closed)

    def test_changed_directory_is_refused_before_resetting_original_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = root / "group"
            original.mkdir()
            peak_path = original / "memory.peak"
            peak_path.write_text("77\n")
            group = LIB.Group(original)
            self.addCleanup(os.close, group.fd)
            peak_fd = os.open(peak_path, os.O_RDWR)
            self.addCleanup(os.close, peak_fd)
            owner = self.owner()
            owner.counters = {"window": (group, peak_fd, {})}
            original.rename(root / "retained-original")
            original.mkdir()
            with self.assertRaisesRegex(ValueError, "identity changed"):
                owner.begin("window")
            self.assertEqual(
                (root / "retained-original/memory.peak").read_text(), "77\n"
            )

    def test_populated_group_is_retained_with_cleanup_error(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "group").mkdir()
            (root / "group/cgroup.events").write_text("populated 1\n")
            parent, group = LIB.Group(root), LIB.Group(root / "group")
            owner = self.owner()
            owner.parent = parent
            owner.groups = [(group, parent, "group")]
            owner.counters = {}
            owner.cleanup_records = []
            errors = owner.cleanup()
            self.assertIn("still populated", errors[0]["error"])
            self.assertTrue((root / "group").exists())
            self.assertEqual(owner.cleanup_records, [])

    def test_preflight_failure_preserves_error_without_success_output(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "failed-capture"
            result = subprocess.run(
                [
                    sys.executable,
                    str(OWNER / "charged_windows_probe.py"),
                    "--output",
                    str(output),
                    "--cgroup-parent",
                    directory,
                ],
                capture_output=True,
                timeout=10,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(json.loads(result.stdout)["qualified"])
            capture = json.loads((output / "capture.json").read_text())
            # Headroom is checked before delegation; constrained CI may stop there.
            self.assertIn(
                capture["error"],
                {
                    "ValueError: parent must be on the cgroup-v2 mount",
                    "ValueError: host availability below qualification floor",
                },
            )
            self.assertFalse(capture["wait_confirmed"])
            self.assertEqual(capture["event_count"], 0)
            self.assertTrue(all(value is False for value in capture["claims"].values()))

    def test_current_process_cannot_be_moved_into_owned_group(self):
        owner = LIB.ChargeWindows.__new__(LIB.ChargeWindows)
        owner.owner_pid = os.getpid()
        with self.assertRaisesRegex(ValueError, "new direct child"):
            owner.enter_new_child()

    def test_invalid_window_identity_is_rejected_before_cgroup_access(self):
        for names in (["same", "same"], ["../escape"], [], ["x"] * 9):
            with self.subTest(names=names), self.assertRaises(ValueError):
                LIB.ChargeWindows(
                    "/not-a-cgroup", names, str(uuid.uuid4()), lambda _: None
                )

    def test_preexisting_output_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            sentinel = Path(directory) / "capture.json"
            sentinel.write_text("previous evidence")
            result = subprocess.run(
                [
                    sys.executable,
                    str(OWNER / "charged_windows_probe.py"),
                    "--output",
                    directory,
                    "--cgroup-parent",
                    "/sys/fs/cgroup",
                ],
                capture_output=True,
                timeout=10,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(sentinel.read_text(), "previous evidence")


if __name__ == "__main__":
    unittest.main()
