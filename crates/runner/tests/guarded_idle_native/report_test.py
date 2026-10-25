#!/usr/bin/env python3
"""Consumer regressions against real receipt/log/sample files."""

import importlib.util
import hashlib
import copy
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
import uuid

spec = importlib.util.spec_from_file_location("native_report", pathlib.Path(__file__).with_name("report.py"))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


def prepare_snapshot_record(root, artifacts):
    """Write synthetic real-file evidence for ordinary consumer tests, never a native run."""
    inputs = {key: artifacts[key] for key in (
        "source_sha", "firecracker_sha256", "kernel_sha256", "rootfs_sha256", "snapshot_id", "profile")}
    inputs["producer_test_binary_sha256"] = artifacts["test_binary_sha256"]
    record = {"format": "native-snapshot-preparation-v1", "inputs": inputs,
              "snapshot_files": artifacts["snapshot_files"],
              "creator_boot_id": "00000000-0000-0000-0000-000000000001",
              "started_monotonic_ns": 1, "completed_monotonic_ns": 2,
              "started_unix_ns": 1001, "completed_unix_ns": 1002}
    raw = json.dumps(record).encode()
    (root / "snapshot-preparation.json").write_bytes(raw)
    artifacts["snapshot_preparation_sha256"] = hashlib.sha256(raw).hexdigest()


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
            "profile": json.loads(os.environ["OKOU_TEST_NATIVE_PROFILE"])
            if "OKOU_TEST_NATIVE_PROFILE" in os.environ else dict(report.NATIVE_PROFILE),
            "required_fixture_tail_bytes": 64 * 1024 * 1024,
        }
        prepare_snapshot_record(self.root, self.artifacts)
        self.collector = {
            "format": "runner-memory-calibration-v2", "success": True,
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
                    "processes": [{"pid": 123, "start_ticks": 456, "rss_bytes": 4096, "pss_bytes": 2048,
                                   "residency_state": "measured", "residency_reason": "smaps_rollup",
                                   "observed_monotonic_ns": clock + 1,
                                   "exit_observed_monotonic_ns": None}],
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
        self.assertTrue(result["snapshot_creation_inputs_verified"])
        self.assertFalse(result["bootstrap_provenance_verified"])

    def test_missing_snapshot_preparation_record_is_refused(self):
        (self.root / "snapshot-preparation.json").unlink(missing_ok=True)
        with self.assertRaisesRegex(ValueError, "snapshot preparation"):
            self.validate()

    def write_preparation(self, record):
        raw = json.dumps(record).encode() if isinstance(record, dict) else record
        (self.root / "snapshot-preparation.json").write_bytes(raw)
        self.artifacts["snapshot_preparation_sha256"] = hashlib.sha256(raw).hexdigest()

    def test_preparation_rejects_every_unbound_creation_input_and_output(self):
        original = json.loads((self.root / "snapshot-preparation.json").read_bytes())
        for field in ("source_sha", "producer_test_binary_sha256", "firecracker_sha256",
                      "kernel_sha256", "rootfs_sha256", "snapshot_id", "profile", "snapshot_files"):
            with self.subTest(field=field):
                value = copy.deepcopy(original)
                if field == "snapshot_files":
                    value[field]["memory.bin"] = "0" * 64
                elif field == "profile":
                    value["inputs"][field]["memory_mib"] = 8192
                elif field == "snapshot_id":
                    value["inputs"][field] = "different-original-snapshot"
                else:
                    value["inputs"][field] = "0" * (40 if field == "source_sha" else 64)
                self.write_preparation(value)
                with self.assertRaisesRegex(ValueError, "snapshot preparation input/output"):
                    self.validate()

    def test_preparation_rejects_invalid_clocks_identity_shape_and_types(self):
        original = json.loads((self.root / "snapshot-preparation.json").read_bytes())
        changes = [
            ("started_monotonic_ns", 0), ("started_monotonic_ns", True),
            ("completed_monotonic_ns", 1), ("completed_monotonic_ns", 2**64),
            ("started_unix_ns", -1), ("completed_unix_ns", 2**128),
            ("creator_boot_id", "invalid-boot"), ("format", "unobserved-producer-v0"),
            ("unknown_field", True),
        ]
        for field, item in changes:
            with self.subTest(field=field, value=item):
                value = copy.deepcopy(original)
                value[field] = item
                self.write_preparation(value)
                with self.assertRaises(ValueError):
                    self.validate()
        value = copy.deepcopy(original)
        value["inputs"]["profile"]["vcpu"] = 2.0
        self.write_preparation(value)
        with self.assertRaises(ValueError):
            self.validate()

    def test_preparation_hash_tampering_and_oversize_are_refused(self):
        path = self.root / "snapshot-preparation.json"
        path.write_bytes(path.read_bytes() + b" ")
        with self.assertRaisesRegex(ValueError, "snapshot preparation record hash"):
            self.validate()
        self.write_preparation(b" " * 65537)
        with self.assertRaisesRegex(ValueError, "snapshot preparation record hash or size"):
            self.validate()

    def test_preparation_duplicate_members_are_refused_at_both_object_levels(self):
        raw = (self.root / "snapshot-preparation.json").read_bytes()
        for member in (b'"format":', b'"memory.bin":'):
            with self.subTest(member=member):
                self.write_preparation(raw.replace(member, member + b'"duplicate",' + member, 1))
                with self.assertRaisesRegex(ValueError, "duplicate field"):
                    self.validate()

    def test_preparation_symlink_and_fifo_are_refused_by_real_cli(self):
        self.validate()
        path = self.root / "snapshot-preparation.json"
        foreign = self.root / "foreign-record.json"
        foreign.write_bytes(path.read_bytes())
        path.unlink()
        command = [sys.executable, report.__file__, str(self.root)]
        path.symlink_to(foreign)
        result = subprocess.run(command, capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("snapshot preparation", result.stderr)
        path.unlink()
        os.mkfifo(path)
        result = subprocess.run(command, capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not a regular file", result.stderr)

    def test_real_cli_transports_creation_record_and_retains_parent_limits(self):
        self.validate()
        command = [sys.executable, report.__file__, str(self.root)]
        result = subprocess.run(command, capture_output=True, text=True, timeout=5, check=True)
        value = json.loads(result.stdout)
        self.assertTrue(value["snapshot_creation_inputs_verified"])
        self.assertFalse(value["bootstrap_provenance_verified"])
        self.assertFalse(value["production_protection_proven"])
        (self.root / "snapshot-preparation.json").unlink()
        self.assertNotEqual(subprocess.run(command, capture_output=True, timeout=5).returncode, 0)

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
        for sample in self.samples[1:]:
            sample["processes"].append({
                "pid": 999, "start_ticks": 888, "rss_bytes": None, "pss_bytes": None,
                "residency_state": "unavailable", "residency_reason": "permission_denied",
                "observed_monotonic_ns": sample["monotonic_ns"],
                "exit_observed_monotonic_ns": None,
            })
        result = self.validate()
        self.assertFalse(result["residency_complete"])

    def test_positive_process_exit_is_diagnostic_not_zero_or_complete_residency(self):
        clock = self.samples[1]["monotonic_ns"]
        for sample in self.samples[1:]:
            sample["processes"].append({
                "pid": 999, "start_ticks": 888, "rss_bytes": None, "pss_bytes": None,
                "residency_state": "exited", "residency_reason": "pidfd_exit",
                "observed_monotonic_ns": sample["monotonic_ns"],
                "exit_observed_monotonic_ns": clock,
            })
        result = self.validate()
        self.assertFalse(result["residency_complete"])
        self.assertFalse(result["memory_envelope_calibrated"])
        self.assertFalse(result["production_protection_proven"])
        self.assertTrue(any(
            window.get("missing_residency_reasons", {}).get("pidfd_exit") == 1
            for case in result["cases"].values() for window in case.values()
            if isinstance(window, dict)))

    def test_malformed_or_contradictory_residency_diagnostics_are_refused(self):
        original = dict(self.samples[0]["processes"][0])
        for changed in (
                {"pid": True}, {"start_ticks": False},
                {"residency_state": "exited"}, {"residency_reason": "permission_denied"},
                {"residency_reason": []}, {"rss_bytes": None}, {"pss_bytes": True},
                {"observed_monotonic_ns": 0}, {"observed_monotonic_ns": 10**12},
                {"exit_observed_monotonic_ns": 1},
                {"residency_state": "unavailable", "residency_reason": "smaps_missing"},
        ):
            with self.subTest(changed=changed):
                self.samples[0]["processes"][0] = dict(original, **changed)
                with self.assertRaisesRegex(ValueError, "residency"):
                    self.validate()
        self.samples[0]["processes"][0] = original

    def test_exit_needs_its_own_positive_consistent_clock(self):
        original = dict(self.samples[0]["processes"][0])
        for clock in (None, False, 0, original["observed_monotonic_ns"] + 1):
            with self.subTest(clock=clock):
                self.samples[0]["processes"][0] = dict(
                    original, residency_state="exited", residency_reason="pidfd_exit",
                    rss_bytes=None, pss_bytes=None, exit_observed_monotonic_ns=clock)
                with self.assertRaisesRegex(ValueError, "exit lacks positive timed evidence"):
                    self.validate()

    def test_captured_generation_and_positive_exit_cannot_change_across_samples(self):
        first, second = [dict(sample["processes"][0]) for sample in self.samples[:2]]
        exited = dict(first, residency_state="exited", residency_reason="pidfd_exit",
                      rss_bytes=None, pss_bytes=None,
                      exit_observed_monotonic_ns=first["observed_monotonic_ns"])
        later_exit = dict(exited, observed_monotonic_ns=second["observed_monotonic_ns"])
        for initial, following in (
                (first, dict(second, start_ticks=457)),
                (exited, second),
                (exited, dict(later_exit, residency_state="unavailable",
                              residency_reason="smaps_missing", exit_observed_monotonic_ns=None)),
                (exited, dict(later_exit, exit_observed_monotonic_ns=second["observed_monotonic_ns"])),
                (first, later_exit),
        ):
            with self.subTest(initial=initial, following=following):
                self.samples[0]["processes"][0] = initial
                self.samples[1]["processes"][0] = following
                with self.assertRaisesRegex(ValueError, "residency"):
                    self.validate()

    def test_missing_diagnostics_duplicate_identity_and_old_current_format_are_refused(self):
        row = self.samples[0]["processes"][0]
        del row["residency_reason"]
        with self.assertRaisesRegex(ValueError, "diagnostic contract"):
            self.validate()
        row["residency_reason"] = "smaps_rollup"
        self.samples[0]["processes"].append(dict(row))
        with self.assertRaisesRegex(ValueError, "duplicate residency identity"):
            self.validate()
        self.samples[0]["processes"].pop()
        self.collector["format"] = "runner-memory-calibration-v1"
        with self.assertRaisesRegex(ValueError, "collector did not positively"):
            self.validate()

    def test_captured_process_cannot_disappear_from_later_samples(self):
        sample = self.samples[0]
        original = dict(sample["processes"][0])
        for state, reason in (("measured", "smaps_rollup"),
                              ("unavailable", "permission_denied"), ("exited", "pidfd_exit")):
            with self.subTest(state=state):
                row = dict(original, pid=999, start_ticks=888,
                           residency_state=state, residency_reason=reason)
                if state != "measured":
                    row.update(rss_bytes=None, pss_bytes=None)
                if state == "exited":
                    row["exit_observed_monotonic_ns"] = sample["monotonic_ns"]
                sample["processes"] = [original, row]
                with self.assertRaisesRegex(ValueError, "captured residency identity disappeared"):
                    self.validate()


if __name__ == "__main__":
    unittest.main()
