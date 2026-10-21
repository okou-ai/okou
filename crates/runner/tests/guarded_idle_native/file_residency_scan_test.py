"""Real original-FD range acquisition and complete original/CLI replay."""

import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid

from file_residency import FileResidency, MAX_EXTENT_BYTES, MAX_SCAN_DURATION_NS
from file_residency_scan import SOURCES, source_bundle
from file_residency_scan_report import replay

OWNER = Path(__file__).resolve().parent
SIZE = MAX_EXTENT_BYTES + 8195


def original(root, size=SIZE):
    path = root / "input.bin"
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.ftruncate(fd, size)
        hash_ = hashlib.sha256()
        if size:
            os.pwrite(fd, b"head", 0)
            os.pwrite(fd, b"end", size - 3)
            hash_.update(b"head")
            remaining = size - 7
            block = bytes(65536)
            while remaining:
                length = min(remaining, len(block))
                hash_.update(block[:length])
                remaining -= length
            hash_.update(b"end")
        os.fsync(fd)
        return path, fd, hash_.hexdigest()
    except BaseException:
        os.close(fd)
        raise


class ScanTests(unittest.TestCase):
    def setUp(self):
        manager = tempfile.TemporaryDirectory()
        self.addCleanup(manager.cleanup)
        self.root = Path(manager.name)
        self.path, self.fd, self.payload_hash = original(self.root)
        self.addCleanup(os.close, self.fd)
        info = os.fstat(self.fd)
        self.identity = info.st_dev, info.st_ino

    def test_large_original_uses_complete_ranges_and_retains_unlinked_custody(self):
        old = self.root / "retained"
        self.path.rename(old)
        self.path.write_bytes(b"replacement")
        old.unlink()
        os.lseek(self.fd, 123, os.SEEK_SET)
        before = len(os.listdir("/proc/self/fd"))
        events = []
        with FileResidency(self.fd, self.identity) as owner:
            result = owner.scan(SIZE, MAX_SCAN_DURATION_NS, events.append)
        self.assertEqual(len(os.listdir("/proc/self/fd")), before)
        self.assertEqual(os.lseek(self.fd, 0, os.SEEK_CUR), 123)
        self.assertEqual(result["before"], result["after"])
        self.assertEqual(result["before"]["links"], 0)
        self.assertEqual(result["covered_bytes"], SIZE)
        self.assertEqual(result["extent_count"], 2)
        self.assertEqual([e["offset"] for e in events], [0, MAX_EXTENT_BYTES])
        self.assertEqual([e["length"] for e in events], [MAX_EXTENT_BYTES, 8195])
        self.assertEqual(
            [len(bytes.fromhex(e["resident_vector_hex"])) for e in events],
            [
                (e["length"] + result["page_size"] - 1) // result["page_size"]
                for e in events
            ],
        )
        self.assertTrue(all(e["mapping_released"] for e in events))
        self.assertTrue(result["original_byte_range_covered"])
        self.assertTrue(all(value is False for value in result["claims"].values()))
        self.assertEqual(
            result["resident_payload_bytes_observed_sum"],
            sum(e["resident_payload_bytes"] for e in events),
        )

    def test_real_between_extent_mutation_preserves_prefix_and_refuses_completion(self):
        events = []

        def emit(point):
            events.append(point)
            os.pwrite(self.fd, b"changed", MAX_EXTENT_BYTES)

        with FileResidency(self.fd, self.identity) as owner:
            with self.assertRaisesRegex(ValueError, "original changed"):
                owner.scan(SIZE, MAX_SCAN_DURATION_NS, emit)
        self.assertEqual(len(events), 1)
        self.assertTrue(events[0]["mapping_released"])
        self.assertEqual(events[0]["offset"], 0)

    def test_output_failure_is_not_completion_and_original_remains_usable(self):
        events = []
        # The owner is allocated before the output descriptor closes, so a new
        # duplicate cannot reuse the deliberately failed output's number.
        with FileResidency(self.fd, self.identity) as owner:
            target = os.open(
                self.root / "sink", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
            )
            descriptor = target
            os.close(target)

            def emit(point):
                events.append(point)
                os.write(descriptor, b"actual output")

            with self.assertRaises(OSError):
                owner.scan(SIZE, MAX_SCAN_DURATION_NS, emit)
            self.assertTrue(owner.observe(0, 4096)["mapping_released"])
        self.assertEqual(len(events), 1)
        self.assertEqual(os.fstat(self.fd).st_size, SIZE)

    def test_acquisition_cli_failure_retains_capture_and_borrowed_original(self):
        root = self.root / "failed-capture"
        result = subprocess.run(
            [
                sys.executable,
                "-B",
                str(OWNER / "file_residency_scan.py"),
                str(root),
                "--fd",
                str(self.fd),
                "--device",
                str(self.identity[0]),
                "--inode",
                str(self.identity[1]),
                "--invocation",
                str(uuid.uuid4()),
                "--source-sha256",
                source_bundle()[2],
                "--original-sha256",
                self.payload_hash,
                "--maximum-bytes",
                str(SIZE - 1),
                "--maximum-duration-ns",
                str(MAX_SCAN_DURATION_NS),
            ],
            pass_fds=(self.fd,),
            capture_output=True,
            text=True,
            timeout=40,
        )
        self.assertEqual(result.returncode, 1)
        receipt = json.loads(result.stdout)
        self.assertFalse(receipt["complete"])
        capture = json.loads((root / "capture.json").read_bytes())
        self.assertIn("byte budget", capture["error"])
        self.assertIsNone(capture["summary"])
        self.assertTrue(capture["cleanup_complete"])
        self.assertEqual(capture["event_count"], 0)
        self.assertEqual((root / "events.jsonl").read_bytes(), b"")
        self.assertEqual(os.fstat(self.fd).st_size, SIZE)

    def test_byte_and_elapsed_budgets_refuse_success(self):
        with FileResidency(self.fd, self.identity) as owner:
            events = []
            with self.assertRaisesRegex(ValueError, "byte budget"):
                owner.scan(SIZE - 1, MAX_SCAN_DURATION_NS, events.append)
            with self.assertRaisesRegex(ValueError, "duration budget"):
                owner.scan(SIZE, 1, events.append)
            self.assertEqual(events, [])

    def test_pre_epoch_file_timestamp_survives_real_cli_and_replay(self):
        os.utime(self.fd, ns=(-1, -1))
        self.assertEqual(os.fstat(self.fd).st_mtime_ns, -1)
        root = self.root / "pre-epoch-capture"
        invocation = str(uuid.uuid4())
        source = source_bundle()[2]
        result = subprocess.run(
            [
                sys.executable,
                "-B",
                str(OWNER / "file_residency_scan.py"),
                str(root),
                "--fd",
                str(self.fd),
                "--device",
                str(self.identity[0]),
                "--inode",
                str(self.identity[1]),
                "--invocation",
                invocation,
                "--source-sha256",
                source,
                "--original-sha256",
                self.payload_hash,
                "--maximum-bytes",
                str(SIZE),
                "--maximum-duration-ns",
                str(MAX_SCAN_DURATION_NS),
            ],
            pass_fds=(self.fd,),
            capture_output=True,
            text=True,
            timeout=40,
        )
        self.assertEqual((result.returncode, result.stderr), (0, ""))
        receipt = json.loads(result.stdout)
        capture = json.loads((root / "capture.json").read_bytes())
        self.assertEqual(capture["summary"]["before"]["mtime_ns"], -1)
        self.assertEqual(capture["summary"]["after"]["mtime_ns"], -1)
        shutil.copyfile(self.path, root / "original.bin")
        self.assertEqual(
            replay(
                root,
                invocation,
                source,
                receipt["capture_sha256"],
                self.identity,
                SIZE,
                MAX_SCAN_DURATION_NS,
            )["covered_bytes"],
            SIZE,
        )

    def test_empty_original_has_zero_ranges_without_broader_claims(self):
        os.ftruncate(self.fd, 0)
        events = []
        with FileResidency(self.fd, self.identity) as owner:
            result = owner.scan(0, MAX_SCAN_DURATION_NS, events.append)
        self.assertEqual(
            (result["covered_bytes"], result["extent_count"], events), (0, 0, [])
        )
        self.assertTrue(all(value is False for value in result["claims"].values()))


class OriginalReplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        manager = tempfile.TemporaryDirectory()
        cls.addClassCleanup(manager.cleanup)
        cls.base = Path(manager.name)
        path, fd, cls.payload_hash = original(cls.base)
        try:
            info = os.fstat(fd)
            cls.identity = info.st_dev, info.st_ino
            cls.invocation = str(uuid.uuid4())
            cls.source_sha256 = source_bundle()[2]
            cls.capture_root = cls.base / "capture"
            os.lseek(fd, 321, os.SEEK_SET)
            result = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(OWNER / "file_residency_scan.py"),
                    str(cls.capture_root),
                    "--fd",
                    str(fd),
                    "--device",
                    str(info.st_dev),
                    "--inode",
                    str(info.st_ino),
                    "--invocation",
                    cls.invocation,
                    "--source-sha256",
                    cls.source_sha256,
                    "--original-sha256",
                    cls.payload_hash,
                    "--maximum-bytes",
                    str(SIZE),
                    "--maximum-duration-ns",
                    str(MAX_SCAN_DURATION_NS),
                ],
                pass_fds=(fd,),
                capture_output=True,
                text=True,
                timeout=40,
            )
            if result.returncode != 0 or result.stderr:
                raise AssertionError((result.returncode, result.stdout, result.stderr))
            if os.lseek(fd, 0, os.SEEK_CUR) != 321:
                raise AssertionError("acquisition changed the borrowed original cursor")
            cls.receipt = json.loads(result.stdout)
        finally:
            os.close(fd)
        shutil.copyfile(path, cls.capture_root / "original.bin")
        cls.capture = json.loads((cls.capture_root / "capture.json").read_bytes())
        cls.events = [
            json.loads(line)
            for line in (cls.capture_root / "events.jsonl").read_bytes().splitlines()
        ]

    def setUp(self):
        manager = tempfile.TemporaryDirectory()
        self.addCleanup(manager.cleanup)
        self.root = Path(manager.name)
        for name in (*SOURCES, "capture.json", "events.jsonl"):
            shutil.copyfile(self.capture_root / name, self.root / name)
        # Only this read-only replay payload is shared; each test's raw records
        # and capture remain separately owned. Mutation tests replace the link.
        os.link(self.capture_root / "original.bin", self.root / "original.bin")

    def check(self, seal=None, invocation=None, identity=None, maximum_bytes=SIZE):
        return replay(
            self.root,
            invocation or self.invocation,
            self.source_sha256,
            seal or self.receipt["capture_sha256"],
            identity or self.identity,
            maximum_bytes,
            MAX_SCAN_DURATION_NS,
        )

    def rewritten(self, change):
        capture = copy.deepcopy(self.capture)
        events = copy.deepcopy(self.events)
        change(capture, events)
        raw = b"".join(json.dumps(e, sort_keys=True).encode() + b"\n" for e in events)
        (self.root / "events.jsonl").write_bytes(raw)
        capture["events_sha256"] = hashlib.sha256(raw).hexdigest()
        raw = json.dumps(capture, sort_keys=True).encode()
        (self.root / "capture.json").write_bytes(raw)
        return hashlib.sha256(raw).hexdigest()

    def test_real_cli_complete_original_replays_with_explicit_temporal_scope(self):
        result = self.check()
        self.assertEqual((result["covered_bytes"], result["extent_count"]), (SIZE, 2))
        self.assertIn("no simultaneous total or interval bound", result["scope"])
        self.assertTrue(all(value is False for value in result["claims"].values()))
        command = [
            sys.executable,
            "-B",
            str(OWNER / "file_residency_scan_report.py"),
            str(self.root),
            "--invocation",
            self.invocation,
            "--source-sha256",
            self.source_sha256,
            "--capture-sha256",
            self.receipt["capture_sha256"],
            "--device",
            str(self.identity[0]),
            "--inode",
            str(self.identity[1]),
            "--maximum-bytes",
            str(SIZE),
            "--maximum-duration-ns",
            str(MAX_SCAN_DURATION_NS),
        ]
        ok = subprocess.run(command, capture_output=True, text=True, timeout=30)
        self.assertEqual((ok.returncode, ok.stderr), (0, ""))
        with (self.root / "events.jsonl").open("ab") as stream:
            stream.write(b"incomplete original\n")
        failed = subprocess.run(command, capture_output=True, text=True, timeout=30)
        self.assertNotEqual(failed.returncode, 0)
        self.assertTrue(failed.stderr)

    def test_external_capture_seal_identity_invocation_and_budgets_bind_replay(self):
        for kwargs in [
            {"invocation": str(uuid.uuid4())},
            {"identity": (self.identity[0], self.identity[1] + 1)},
            {"maximum_bytes": SIZE + 1},
        ]:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.check(**kwargs)
        with (self.root / "capture.json").open("ab") as stream:
            stream.write(b" ")
        with self.assertRaisesRegex(ValueError, "seal"):
            self.check()

    def test_missing_overlapping_reordered_or_foreign_ranges_are_refused(self):
        mutations = {
            "missing_suffix": lambda c, e: e.pop(),
            "overlap": lambda c, e: e[1].update(offset=0),
            "order": lambda c, e: e.reverse(),
            "foreign_original": lambda c, e: e[1]["before"].update(
                inode=self.identity[1] + 1
            ),
            "foreign_observer": lambda c, e: e[1]["observer"].update(
                start_ticks=e[1]["observer"]["start_ticks"] + 1
            ),
            "vector": lambda c, e: e[1].update(resident_vector_hex="00"),
        }
        for name, change in mutations.items():
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.check(seal=self.rewritten(change))

    def test_unretired_over_budget_and_unsupported_claims_are_refused(self):
        mutations = {
            "no_complete_range": lambda c, e: c["summary"].update(
                original_byte_range_covered=False
            ),
            "mapping": lambda c, e: e[0].update(mapping_released=False),
            "descriptor": lambda c, e: c.update(
                descriptor_count_after=c["descriptor_count_before"] + 1
            ),
            "cost": lambda c, e: c["summary"].update(
                acquisition_ns=MAX_SCAN_DURATION_NS + 1
            ),
            "native_claim": lambda c, e: c["claims"].update(native_guest_executed=True),
            "failed_acquisition": lambda c, e: c.update(
                error="actual failed acquisition"
            ),
            "boolean_metadata": lambda c, e: e[0]["before"].update(links=True),
        }
        for name, change in mutations.items():
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.check(seal=self.rewritten(change))

    def test_changed_original_source_and_complete_payload_are_refused(self):
        with (self.root / SOURCES[0]).open("ab") as stream:
            stream.write(b"\n# changed original source\n")
        with self.assertRaisesRegex(ValueError, "source"):
            self.check()
        shutil.copyfile(self.capture_root / SOURCES[0], self.root / SOURCES[0])
        (self.root / "original.bin").unlink()
        shutil.copyfile(self.capture_root / "original.bin", self.root / "original.bin")
        with (self.root / "original.bin").open("r+b") as stream:
            stream.write(b"changed")
        with self.assertRaisesRegex(ValueError, "payload hash"):
            self.check()


if __name__ == "__main__":
    unittest.main()
