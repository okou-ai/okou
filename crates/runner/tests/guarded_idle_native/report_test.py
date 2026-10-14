#!/usr/bin/env python3
"""Consumer regressions against real receipt/log/sample files."""

import importlib.util
import json
import pathlib
import tempfile
import unittest
import uuid

spec = importlib.util.spec_from_file_location("native_report", pathlib.Path(__file__).with_name("report.py"))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class NativeReportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.artifacts = {
            "source_sha": "a" * 40, "test_binary_sha256": "b" * 64,
            "firecracker_sha256": "c" * 64, "kernel_sha256": "d" * 64,
            "snapshot_id": "native-fixture",
            "rootfs_sha256": "e" * 64, "snapshot_files": {name: "f" * 64 for name in (
                "snapshot.bin", "memory.bin", "cow.img", "cow.img.bitmap", ".snapshot-complete")},
            "policy_sha256": "1" * 64,
            "profile": {"vcpu": 2, "memory_mib": 4096, "home_mib": 16384},
            "required_fixture_tail_bytes": 64 * 1024 * 1024,
        }
        self.collector = {
            "format": "runner-memory-calibration-v1", "success": True,
            "cleanup_confirmed": True, "driver_wait_confirmed": True, "driver_exit_code": 0,
            "remaining_children": [], "errors": [],
            "metadata": {"native_terminal_artifacts": self.artifacts},
        }
        for field in ("cleanup_intervened", "timed_out", "headroom_stop", "logs_truncated",
                      "calibrated", "native_vm_exit_confirmed"):
            self.collector[field] = False
        self.events, self.samples = [], []
        clock = 10
        for case in sorted(report.CASES):
            sandbox, backing = str(uuid.uuid4()), str(uuid.uuid4())
            evidence = [
                {"artifacts": self.artifacts}, {}, {"positive_owned_wait": True},
                {"bytes": 64 * 1024 * 1024, "full_logical_lease": [2, 4096, 1]},
                {"written_and_verified_bytes": 64 * 1024 * 1024},
                {"original_home_restored": True, "private_runtime_removed": True,
                 "required_cleanup_joined": True, "full_lease_released_after_cleanup": True,
                 "home_payload_bytes": 65536},
            ]
            for phase, proof in zip(report.PHASES, evidence):
                self.events.append({
                    "version": 1, "case": case, "phase": phase, "monotonic_ns": clock,
                    "unix_ns": clock + 1000, "sandbox_id": sandbox,
                    "backing_generation": backing, "evidence": proof,
                })
                self.samples.append({
                    "monotonic_ns": clock + 1, "mem_available_bytes": 100000,
                    "sample_age_ns": 2, "read_duration_ns": 1,
                    "processes": [{"pid": 123, "start_ticks": 456, "rss_bytes": 4096, "pss_bytes": 2048}],
                })
                clock += 10

    def validate(self):
        (self.root / "report.json").write_text(json.dumps(self.collector))
        (self.root / "stdout.log").write_text("\n".join(
            report.PREFIX + json.dumps(e) for e in self.events))
        (self.root / "samples.jsonl").write_text("\n".join(json.dumps(s) for s in self.samples))
        return report.validate(self.root)

    def test_positive_native_proof_retains_generic_collector_limits(self):
        result = self.validate()
        self.assertEqual(len(result["cases"]), 12)
        self.assertFalse(result["memory_envelope_calibrated"])

    def test_missing_scope_and_duplicate_phase_are_refused(self):
        self.events.pop()
        with self.assertRaisesRegex(ValueError, "missing, duplicate"):
            self.validate()
        self.events.append(self.events[-1])
        with self.assertRaises(ValueError):
            self.validate()

    def test_late_backing_rebind_is_refused(self):
        self.events[3]["backing_generation"] = str(uuid.uuid4())
        with self.assertRaisesRegex(ValueError, "backing was reused or changed"):
            self.validate()

    def test_backing_reused_by_another_case_is_refused(self):
        for event in self.events[6:12]:
            event["backing_generation"] = self.events[1]["backing_generation"]
        with self.assertRaisesRegex(ValueError, "backing was reused or changed"):
            self.validate()

    def test_wrong_artifact_is_refused(self):
        self.events[0]["evidence"] = {"artifacts": {"source_sha": "c" * 40}}
        with self.assertRaisesRegex(ValueError, "artifact/input identity mismatch"):
            self.validate()

    def test_wrong_snapshot_creation_identity_is_refused(self):
        changed = dict(self.artifacts, snapshot_id="different-native-fixture")
        self.events[0]["evidence"] = {"artifacts": changed}
        with self.assertRaisesRegex(ValueError, "artifact/input identity mismatch"):
            self.validate()

    def test_snapshot_identity_cannot_escape_its_runtime_directory(self):
        for invalid in ("..", "../foreign", "", "a" * 71):
            self.artifacts["snapshot_id"] = invalid
            with self.assertRaisesRegex(ValueError, "invalid native snapshot creation identity"):
                self.validate()

    def test_cleanup_intervention_cannot_prove_native_completion(self):
        self.collector["cleanup_intervened"] = True
        with self.assertRaisesRegex(ValueError, "collector did not positively"):
            self.validate()

    def test_missing_cleanup_inventory_and_boolean_exit_code_are_refused(self):
        self.collector.pop("remaining_children")
        with self.assertRaises(ValueError):
            self.validate()
        self.collector["remaining_children"] = []
        self.collector["driver_exit_code"] = False
        with self.assertRaises(ValueError):
            self.validate()

    def test_incomplete_manifest_and_boolean_version_are_refused(self):
        removed = self.artifacts.pop("policy_sha256")
        with self.assertRaisesRegex(ValueError, "incomplete native artifact manifest"):
            self.validate()
        self.artifacts["policy_sha256"] = removed
        removed_snapshot = self.artifacts["snapshot_files"].pop("cow.img")
        with self.assertRaisesRegex(ValueError, "invalid native snapshot manifest"):
            self.validate()
        self.artifacts["snapshot_files"]["cow.img"] = removed_snapshot
        self.events[0]["version"] = True
        with self.assertRaisesRegex(ValueError, "receipt version"):
            self.validate()

    def test_missing_tail_window_is_not_zero_byte_success(self):
        self.samples = [s for s in self.samples if not 40 <= s["monotonic_ns"] <= 50]
        with self.assertRaisesRegex(ValueError, "no actual P1 samples"):
            self.validate()

    def test_unknown_residency_remains_an_explicit_lower_bound(self):
        self.samples[1]["processes"].append({
            "pid": 999, "start_ticks": 888, "rss_bytes": None, "pss_bytes": None,
        })
        result = self.validate()
        self.assertFalse(result["residency_complete"])


if __name__ == "__main__":
    unittest.main()
