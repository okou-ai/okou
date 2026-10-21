"""Real-file acquisition and original-evidence/CLI qualification contracts."""

import ctypes
import errno
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch
import uuid

import file_residency as acquisition
from file_residency_probe import qualify
from file_residency_report import replay

OWNER = Path(__file__).resolve().parent


class AcquisitionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.page = os.sysconf("SC_PAGESIZE")
        self.path = self.root / "original"
        self.fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
        self.addCleanup(os.close, self.fd)
        os.write(self.fd, b"a" * (2 * self.page + 3))
        value = os.fstat(self.fd)
        self.identity = value.st_dev, value.st_ino

    def test_original_survives_caller_close_replacement_unlink_and_growth(self):
        caller = os.dup(self.fd)
        with acquisition.FileResidency(caller, self.identity) as owner:
            os.close(caller)
            original = self.root / "old-name"
            self.path.rename(original)
            self.path.write_bytes(b"replacement")
            original.unlink()
            os.lseek(self.fd, 0, os.SEEK_END)
            os.write(self.fd, b"b" * self.page)
            result = owner.observe(0, 3 * self.page + 3)
            self.assertEqual(
                (result["before"]["device"], result["before"]["inode"]), self.identity
            )
            self.assertEqual(result["before"]["links"], 0)
            self.assertEqual(result["before"]["size"], 3 * self.page + 3)
            self.assertEqual(len(bytes.fromhex(result["resident_vector_hex"])), 4)
            self.assertEqual(result["before"], result["after"])
            self.assertTrue(result["mapping_released"])

    def test_offset_partial_page_and_positive_resource_retirement(self):
        before = len(os.listdir("/proc/self/fd"))
        with acquisition.FileResidency(self.fd, self.identity) as owner:
            result = owner.observe(self.page, self.page + 3)
            self.assertEqual(len(bytes.fromhex(result["resident_vector_hex"])), 2)
            self.assertLessEqual(result["resident_payload_bytes"], self.page + 3)
            self.assertEqual(
                result["acquisition_ns"],
                result["completed_monotonic_ns"] - result["started_monotonic_ns"],
            )
        self.assertEqual(len(os.listdir("/proc/self/fd")), before)

    def test_invalid_and_unbounded_extents_refuse_before_mapping(self):
        os.ftruncate(self.fd, acquisition.MAX_EXTENT_BYTES + self.page)
        with acquisition.FileResidency(self.fd, self.identity) as owner:
            for offset, length in [
                (1, 1),
                (0, 0),
                (0, acquisition.MAX_EXTENT_BYTES + 1),
                (acquisition.MAX_EXTENT_BYTES + self.page, 1),
            ]:
                with self.subTest(offset=offset, length=length), self.assertRaises(
                    ValueError
                ):
                    owner.observe(offset, length)

    def test_reused_caller_fd_cannot_change_the_expected_original(self):
        other = os.open(self.root / "other", os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            before = len(os.listdir("/proc/self/fd"))
            with self.assertRaisesRegex(ValueError, "foreign original"):
                acquisition.FileResidency(other, self.identity)
            self.assertEqual(len(os.listdir("/proc/self/fd")), before)
        finally:
            os.close(other)

    def test_mutation_at_the_actual_query_boundary_is_not_a_zero_sample(self):
        real = acquisition.LIBC.mincore

        def mutate(*args):
            os.ftruncate(self.fd, 3 * self.page)
            return real(*args)

        with acquisition.FileResidency(self.fd, self.identity) as owner:
            with patch.object(acquisition.LIBC, "mincore", side_effect=mutate):
                with self.assertRaisesRegex(ValueError, "changed during"):
                    owner.observe(0, 2 * self.page)
            self.assertEqual(
                owner.observe(0, 3 * self.page)["before"]["size"], 3 * self.page
            )

    def test_foreign_thread_has_no_observation_or_close_authority(self):
        with acquisition.FileResidency(self.fd, self.identity) as owner:
            with ThreadPoolExecutor(max_workers=1) as pool:
                for method in [lambda: owner.observe(0, self.page), owner.close]:
                    with self.assertRaisesRegex(ValueError, "foreign"):
                        pool.submit(method).result()
            self.assertTrue(owner.observe(0, self.page)["mapping_released"])

    def test_finished_creator_thread_does_not_transfer_authority(self):
        # A subprocess owns the orphaned descriptor until normal process exit:
        # neither a successor thread nor this test may retire the dead owner's FD.
        result = subprocess.run(
            [
                sys.executable,
                "-B",
                "-c",
                textwrap.dedent(
                    """\
                    import json
                    import os
                    import sys
                    import threading
                    from file_residency import FileResidency

                    owners = []
                    outcomes = {}
                    with open(sys.argv[1], "rb") as source:
                        info = os.fstat(source.fileno())
                        def create():
                            outcomes["creator_ident"] = threading.get_ident()
                            owners.append(FileResidency(
                                source.fileno(), (info.st_dev, info.st_ino)))
                        creator = threading.Thread(target=create)
                        creator.start()
                        creator.join()
                        def use():
                            outcomes["successor_ident"] = threading.get_ident()
                            for label, action in [
                                ("observe", lambda: owners[0].observe(0, 4096)),
                                ("close", owners[0].close),
                            ]:
                                try:
                                    action()
                                    outcomes[label] = "accepted"
                                except ValueError as error:
                                    outcomes[label] = str(error)
                        successor = threading.Thread(target=use)
                        successor.start()
                        successor.join()
                    print(json.dumps(outcomes))
                    """
                ),
                str(self.path),
            ],
            cwd=OWNER,
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        outcomes = json.loads(result.stdout)
        self.assertEqual(outcomes["observe"], "foreign observation owner")
        self.assertEqual(outcomes["close"], "foreign close owner")

    def test_filesystem_credential_mismatch_refuses_without_leaking_duplicate(self):
        before = len(os.listdir("/proc/self/fd"))
        uid = os.geteuid()
        with patch.object(acquisition.os, "geteuid", return_value=uid + 1):
            with self.assertRaisesRegex(ValueError, "filesystem uid mismatch"):
                acquisition.FileResidency(self.fd, self.identity)
        self.assertEqual(len(os.listdir("/proc/self/fd")), before)

    def test_native_thread_reuse_does_not_transfer_authority(self):
        result = subprocess.run(
            [
                sys.executable,
                "-B",
                "-c",
                textwrap.dedent(
                    """\
                    import ctypes
                    import json
                    import os
                    import sys
                    from file_residency import FileResidency

                    libc = ctypes.CDLL(None)
                    callback = ctypes.CFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p)
                    libc.pthread_create.argtypes = [ctypes.POINTER(ctypes.c_ulong),
                        ctypes.c_void_p, callback, ctypes.c_void_p]
                    libc.pthread_create.restype = ctypes.c_int
                    libc.pthread_join.argtypes = [ctypes.c_ulong, ctypes.c_void_p]
                    libc.pthread_join.restype = ctypes.c_int
                    owners = []
                    outcomes = {}
                    with open(sys.argv[1], "rb") as source:
                        info = os.fstat(source.fileno())
                        @callback
                        def create(_):
                            owners.append(FileResidency(
                                source.fileno(), (info.st_dev, info.st_ino)))
                        @callback
                        def use(_):
                            for label, action in [
                                ("observe", lambda: owners[0].observe(0, 4096)),
                                ("close", owners[0].close),
                            ]:
                                try:
                                    action()
                                    outcomes[label] = "accepted"
                                except ValueError as error:
                                    outcomes[label] = str(error)
                        for action in (create, use):
                            handle = ctypes.c_ulong()
                            assert libc.pthread_create(ctypes.byref(handle), None,
                                                      action, None) == 0
                            assert libc.pthread_join(handle, None) == 0
                    print(json.dumps(outcomes))
                    """
                ),
                str(self.path),
            ],
            cwd=OWNER,
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        outcomes = json.loads(result.stdout)
        self.assertEqual(outcomes["observe"], "foreign observation owner")
        self.assertEqual(outcomes["close"], "foreign close owner")

    def test_overflow_uid_cannot_claim_an_unmapped_file_owner(self):
        result = subprocess.run(
            [
                sys.executable,
                "-B",
                "-c",
                textwrap.dedent(
                    """\
                    import ctypes
                    import errno
                    import json
                    import os
                    from pathlib import Path
                    import sys
                    from file_residency import FileResidency

                    uid = os.geteuid()
                    overflow = int(Path('/proc/sys/kernel/overflowuid').read_text())
                    libc = ctypes.CDLL(None, use_errno=True)
                    if libc.unshare(0x10000000) != 0:
                        error = ctypes.get_errno()
                        if error in (errno.EPERM, errno.EACCES, errno.EINVAL, errno.ENOSYS):
                            print('user namespace unavailable: errno ' + str(error))
                            sys.exit(77)
                        raise OSError(error, 'unshare')
                    try:
                        Path('/proc/self/uid_map').write_text(f'{overflow} {uid} 1\\n')
                    except PermissionError as error:
                        print('user namespace uid mapping unavailable: ' + str(error))
                        sys.exit(77)
                    with open('/proc/self/exe', 'rb') as source:
                        info = os.fstat(source.fileno())
                        try:
                            with FileResidency(source.fileno(), (info.st_dev, info.st_ino)):
                                outcome = 'accepted'
                        except ValueError as error:
                            outcome = str(error)
                    print(json.dumps({'uid': os.geteuid(), 'owner': info.st_uid,
                                      'overflow': overflow, 'outcome': outcome}))
                    """
                ),
            ],
            cwd=OWNER,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 77:
            self.skipTest(result.stdout.strip())
        self.assertEqual(result.returncode, 0, result.stderr)
        outcome = json.loads(result.stdout)
        self.assertEqual(outcome["uid"], outcome["overflow"])
        self.assertEqual(outcome["owner"], outcome["overflow"])
        self.assertEqual(outcome["outcome"], "ambiguous overflow uid authority")

    def test_failed_query_releases_mapping_and_keeps_original_usable(self):
        with acquisition.FileResidency(self.fd, self.identity) as owner:
            ctypes.set_errno(errno.EIO)
            with patch.object(acquisition.LIBC, "mincore", return_value=-1):
                with self.assertRaises(OSError):
                    owner.observe(0, self.page)
            self.assertTrue(owner.observe(0, self.page)["mapping_released"])

    def test_failed_mmap_does_not_create_a_mapping_to_retire(self):
        with acquisition.FileResidency(self.fd, self.identity) as owner:
            ctypes.set_errno(errno.ENOMEM)
            with patch.object(
                acquisition.LIBC, "mmap", return_value=acquisition.MAP_FAILED
            ):
                with self.assertRaises(OSError):
                    owner.observe(0, self.page)
            self.assertTrue(owner.observe(0, self.page)["mapping_released"])

    def test_failed_unmap_keeps_original_until_explicit_positive_cleanup(self):
        before = len(os.listdir("/proc/self/fd"))
        with acquisition.FileResidency(self.fd, self.identity) as owner:
            ctypes.set_errno(errno.EBUSY)
            with patch.object(acquisition.LIBC, "munmap", return_value=-1):
                with self.assertRaises(OSError):
                    owner.observe(0, self.page)
            with self.assertRaisesRegex(ValueError, "earlier original mapping"):
                owner.observe(0, self.page)
        self.assertEqual(len(os.listdir("/proc/self/fd")), before)

    def test_uncertain_close_never_repeats_against_a_reused_descriptor(self):
        owner = acquisition.FileResidency(self.fd, self.identity)
        real_close = os.close
        retired = []

        def uncertain(fd):
            retired.append(fd)
            real_close(fd)
            raise OSError(errno.EINTR, "simulated close report after actual retirement")

        with patch.object(acquisition.os, "close", side_effect=uncertain):
            with self.assertRaises(OSError):
                owner.close()
        unrelated = os.open(
            self.root / "unrelated", os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600
        )
        try:
            self.assertEqual(unrelated, retired[0])
            with self.assertRaisesRegex(ValueError, "uncertain"):
                owner.close()
            self.assertEqual(os.fstat(unrelated).st_size, 0)
        finally:
            real_close(unrelated)

    def test_closed_owner_refuses_observations(self):
        owner = acquisition.FileResidency(self.fd, self.identity)
        owner.close()
        owner.close()
        with self.assertRaisesRegex(ValueError, "closed"):
            owner.observe(0, self.page)


class ReplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.original.cleanup)
        cls.proof = Path(cls.original.name) / "proof"
        cls.report = qualify(cls.proof)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "downloaded-copy"
        shutil.copytree(self.proof, self.root)
        self.invocation = self.report["invocation"]
        self.source = self.report["source_sha256"]

    def capture(self):
        return json.loads((self.root / "capture.json").read_text())

    def save_capture(self, capture):
        (self.root / "capture.json").write_text(json.dumps(capture))

    def mutate_event(self, mutate):
        events = [
            json.loads(line)
            for line in (self.root / "events.jsonl").read_text().splitlines()
        ]
        mutate(events)
        raw = b"".join(json.dumps(event).encode() + b"\n" for event in events)
        (self.root / "events.jsonl").write_bytes(raw)
        capture = self.capture()
        capture["events_sha256"] = hashlib.sha256(raw).hexdigest()
        self.save_capture(capture)

    def validate(self):
        return replay(self.root, self.invocation, self.source)

    def test_complete_original_copy_and_real_cli_replay(self):
        self.assertEqual(self.validate(), self.report)
        result = subprocess.run(
            [
                sys.executable,
                "-B",
                str(OWNER / "file_residency_report.py"),
                str(self.root),
                "--invocation",
                self.invocation,
                "--source-sha256",
                self.source,
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report, self.report)
        self.assertTrue(report["cleanup_complete"])
        self.assertTrue(all(value is False for value in report["claims"].values()))

    def test_foreign_invocation_is_not_replayed_as_current(self):
        with self.assertRaisesRegex(ValueError, "foreign/replayed"):
            replay(self.root, str(uuid.uuid4()), self.source)

    def test_changed_original_runtime_source_is_refused(self):
        with (self.root / "file_residency.py").open("ab") as stream:
            stream.write(b"\n# substituted source\n")
        with self.assertRaisesRegex(ValueError, "source changed"):
            self.validate()

    def test_original_complete_payload_corruption_is_refused(self):
        with (self.root / "original.bin").open("r+b") as stream:
            stream.write(b"x")
        with self.assertRaisesRegex(ValueError, "complete payload"):
            self.validate()

    def test_original_identity_cannot_follow_the_replacement(self):
        other = self.capture()["replacement_identity"]

        def mutate(events):
            events[1]["before"].update(other)
            events[1]["after"].update(other)

        self.mutate_event(mutate)
        with self.assertRaisesRegex(ValueError, "foreign original"):
            self.validate()

    def test_changed_during_acquisition_is_refused(self):
        self.mutate_event(lambda events: events[0]["after"].update(size=0))
        with self.assertRaisesRegex(ValueError, "mutated during"):
            self.validate()

    def test_overflow_uid_cannot_certify_original_authority(self):
        uid = self.capture()["host"]["effective_uid"]
        self.mutate_event(
            lambda events: events[0]["authority"].update(overflow_uid=uid)
        )
        with self.assertRaisesRegex(ValueError, "overflow uid authority"):
            self.validate()

    def test_boolean_cannot_hide_an_original_numeric_metadata_change(self):
        self.mutate_event(lambda events: events[2]["after"].update(links=False))
        with self.assertRaisesRegex(ValueError, "invalid integer"):
            self.validate()

    def test_reordered_original_phase_clocks_are_refused(self):
        self.mutate_event(
            lambda events: events[2].update(
                started_monotonic_ns=events[0]["started_monotonic_ns"]
            )
        )
        with self.assertRaisesRegex(ValueError, "order/span"):
            self.validate()

    def test_reused_native_tid_cannot_change_its_task_generation(self):
        def mutate(events):
            events[1]["observer"]["thread_start_ticks"] += 1

        self.mutate_event(mutate)
        with self.assertRaisesRegex(ValueError, "observer generation changed"):
            self.validate()

    def test_truncated_extent_vector_cannot_be_counted_as_complete(self):
        self.mutate_event(lambda events: events[3].update(resident_vector_hex="01"))
        with self.assertRaisesRegex(ValueError, "fully observed"):
            self.validate()

    def test_missing_original_is_failure_at_the_real_cli(self):
        (self.root / "events.jsonl").unlink()
        result = subprocess.run(
            [
                sys.executable,
                "-B",
                str(OWNER / "file_residency_report.py"),
                str(self.root),
                "--invocation",
                self.invocation,
                "--source-sha256",
                self.source,
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")

    def test_symlinked_payload_cannot_substitute_an_original(self):
        (self.root / "original.bin").unlink()
        (self.root / "original.bin").symlink_to(self.proof / "original.bin")
        with self.assertRaises(OSError):
            self.validate()

    def test_full_native_claim_and_incomplete_cleanup_are_refused(self):
        capture = self.capture()
        capture["claims"]["relevant_native_residency_complete"] = True
        self.save_capture(capture)
        with self.assertRaisesRegex(ValueError, "completeness"):
            self.validate()
        capture["claims"]["relevant_native_residency_complete"] = False
        capture["remaining_qualification_mappings"] = 1
        self.save_capture(capture)
        with self.assertRaisesRegex(ValueError, "cleanup"):
            self.validate()

    def test_duplicate_json_cannot_hide_original_failure(self):
        capture = (self.root / "capture.json").read_bytes()
        (self.root / "capture.json").write_bytes(capture[:-1] + b', "error": null}')
        with self.assertRaisesRegex(ValueError, "duplicate JSON"):
            self.validate()

    def test_existing_output_is_never_overwritten(self):
        result = subprocess.run(
            [
                sys.executable,
                "-B",
                str(OWNER / "file_residency_probe.py"),
                "--output",
                str(self.root),
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.validate(), self.report)


if __name__ == "__main__":
    unittest.main()
