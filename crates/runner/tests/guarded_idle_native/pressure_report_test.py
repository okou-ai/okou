#!/usr/bin/env python3
"""Real-file and CLI regressions for the native pressure evidence contract."""

import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
import uuid

import pressure_report
import report
from report_test import prepare_snapshot_record


class PressureReportTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.prepare("physical")

    def prepare(self, kind):
        gib = 1024**3
        self.policy = {
            "host_total_bytes": 64*gib, "operating_floor_bytes": gib,
            "cleanup_reserve_bytes": 256*1024**2, "critical_available_bytes": 12*gib,
            "recovery_available_bytes": 20*gib, "live_growth_bytes": 4*1024**2,
            "tail_growth_bytes": 65*1024**2, "replacement_preparation_bytes": 32*1024**2,
            "max_sample_age_millis": 1000, "max_operations": 8, "max_cleanup_inflight": 2,
            "pressure_sample_period_millis": 50, "pressure_recovery_sustain_millis": 100,
            "pressure_wave_cooldown_millis": 100, "pressure_optional_start_interval_millis": 100,
            "pressure_max_wave_entries": 1,
        }
        raw_policy = json.dumps(self.policy)
        self.artifacts = {
            "source_sha": "a"*40, "test_binary_sha256": "b"*64,
            "firecracker_sha256": "c"*64, "kernel_sha256": "d"*64,
            "rootfs_sha256": "e"*64, "snapshot_id": "native-pressure-fixture",
            "snapshot_files": {name: "f"*64 for name in (
                "snapshot.bin", "memory.bin", "cow.img", "cow.img.bitmap", ".snapshot-complete")},
            "policy_sha256": hashlib.sha256(raw_policy.encode()).hexdigest(),
            "profile": dict(report.NATIVE_PROFILE),
            "required_fixture_tail_bytes": 64*1024**2,
        }
        prepare_snapshot_record(self.root, self.artifacts)
        self.collector = {
            "format": "runner-memory-calibration-v2", "success": True,
            "cleanup_confirmed": True, "driver_wait_confirmed": True, "driver_exit_code": 0,
            "remaining_children": [], "errors": [],
            "metadata": {"native_terminal_artifacts": self.artifacts,
                         "native_pressure_kind": kind, "native_pressure_policy_json": raw_policy},
            **{k: False for k in ("cleanup_intervened", "timed_out", "headroom_stop",
                                 "logs_truncated", "calibrated", "native_vm_exit_confirmed")},
        }
        self.events, self.samples, self.witnesses = [], [], []
        clock = 10
        for mode in ("fresh", "snapshot"):
            case = f"{'Pressure' if kind == 'physical' else 'Logical'}-{mode}"
            sandbox, backing = str(uuid.uuid4()), str(uuid.uuid4())
            condition = {"kind": kind, "policy": self.policy, "available_bytes": (10 if kind == "physical" else 32)*gib,
                         "age_ns": 2, "read_duration_ns": 1, "allocated": [2, 4096, 1],
                         "profile_can_fit": kind == "physical"}
            proofs = [
                {"artifacts": self.artifacts}, condition, {}, {"positive_owned_wait": True},
                {"bytes": 64*1024**2, "full_logical_lease": [2, 4096, 1]},
                {"written_and_verified_bytes": 64*1024**2},
                {"original_home_restored": True, "private_runtime_removed": True,
                 "required_cleanup_joined": True, "full_lease_released_after_cleanup": True,
                 "home_payload_bytes": 65536},
            ]
            phases = ("case_started", "scenario_observed", "terminal_started", "backing_exit_confirmed",
                      "required_tail_started", "required_tail_completed", "case_completed")
            for phase, evidence in zip(phases, proofs):
                self.events.append({"version": 1, "case": case, "phase": phase,
                                    "monotonic_ns": clock, "unix_ns": clock+1000,
                                    "sandbox_id": sandbox, "backing_generation": backing,
                                    "evidence": evidence})
                self.samples.append({"monotonic_ns": clock+1, "mem_available_bytes": 10*gib,
                                     "sample_age_ns": 2, "read_duration_ns": 1,
                                     "processes": [{"pid": 123, "start_ticks": 456,
                                                    "rss_bytes": 4096, "pss_bytes": 2048,
                                                    "residency_state": "measured",
                                                    "residency_reason": "smaps_rollup",
                                                    "observed_monotonic_ns": clock+1,
                                                    "exit_observed_monotonic_ns": None}]})
                clock += 10
            if kind == "physical":
                values = [("wave_completed", {"selected": 1, "completed": 1, "uncertain": 0,
                           "not_started": 0, "skipped": 0, "status_error": False, "resolved": True,
                           "producer_lost": False, "wave_inflight": False, "stopped": True})]
            else:
                values = [("different_guest_prepared", {"incoming_sandbox_id": str(uuid.uuid4()), "admitted": True}),
                          ("original_join_requested", {"retirements": 1})]
            for offset, (phase, evidence) in enumerate(values):
                self.witnesses.append({"version": 1, "case": case, "phase": phase,
                                       "monotonic_ns": clock-15+offset, "unix_ns": clock+1000,
                                       "sandbox_id": sandbox, "backing_generation": backing,
                                       "evidence": evidence})
            clock += 20

    def write(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"stdout.log").write_text("\n".join(
            [report.PREFIX+json.dumps(e) for e in self.events]
            + [pressure_report.PREFIX+json.dumps(w) for w in self.witnesses]))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(s) for s in self.samples))

    def validate(self):
        self.write()
        return pressure_report.validate(self.root)

    def test_both_complete_corpora_report_only_their_actual_scope(self):
        for kind in ("physical", "logical"):
            with self.subTest(kind=kind):
                self.prepare(kind)
                result = self.validate()
                self.assertEqual(result["kind"], kind)
                self.assertEqual(len(result["cases"]), 2)
                self.assertTrue(result["native_pressure_corpus_complete"])
                self.assertFalse(result["memory_envelope_calibrated"])
                self.assertFalse(result["production_protection_proven"])
                self.assertNotIn("native_terminal_corpus_complete", result)

    def test_cli_returns_complete_json_and_rejects_missing_witness(self):
        self.write()
        command = [sys.executable, str(pathlib.Path(__file__).with_name("pressure_report.py")), str(self.root)]
        result = subprocess.run(command, capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)["format"], "native-pressure-phase-report-v1")
        self.witnesses.pop()
        self.write()
        refused = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("native pressure witnesses", refused.stderr)

    def test_missing_mode_and_mixed_corpus_are_refused(self):
        self.events.pop()
        with self.assertRaises(ValueError): self.validate()
        self.prepare("physical")
        self.events[0]["case"] = "Logical-fresh"
        with self.assertRaises(ValueError): self.validate()

    def test_real_policy_condition_and_free_profile_are_required(self):
        self.events[1]["evidence"]["available_bytes"] = self.policy["critical_available_bytes"]+1
        with self.assertRaisesRegex(ValueError, "condition is absent"): self.validate()
        self.prepare("physical")
        self.events[1]["evidence"]["profile_can_fit"] = False
        with self.assertRaisesRegex(ValueError, "condition is absent"): self.validate()

    def test_logical_capacity_and_fitting_headroom_are_required(self):
        self.prepare("logical")
        self.events[1]["evidence"]["profile_can_fit"] = True
        with self.assertRaises(ValueError): self.validate()
        self.prepare("logical")
        self.events[1]["evidence"]["available_bytes"] = 4096
        with self.assertRaises(ValueError): self.validate()

    def test_policy_hash_and_original_values_are_bound(self):
        self.collector["metadata"]["native_pressure_policy_json"] += " "
        with self.assertRaisesRegex(ValueError, "raw policy/hash"): self.validate()
        self.prepare("physical")
        self.events[1]["evidence"]["policy"] = dict(self.policy, critical_available_bytes=1)
        with self.assertRaises(ValueError): self.validate()

    def test_duplicate_policy_field_is_refused_even_with_matching_hash(self):
        raw = self.collector["metadata"]["native_pressure_policy_json"]
        raw = raw[:-1]+', "host_total_bytes": '+str(self.policy["host_total_bytes"])+"}"
        self.collector["metadata"]["native_pressure_policy_json"] = raw
        self.artifacts["policy_sha256"] = hashlib.sha256(raw.encode()).hexdigest()
        with self.assertRaisesRegex(ValueError, "duplicate"): self.validate()

    def test_stale_age_and_boolean_budget_are_refused(self):
        self.events[1]["evidence"]["age_ns"] = 1_000_000_000
        with self.assertRaises(ValueError): self.validate()
        self.prepare("physical")
        self.events[1]["evidence"]["allocated"][-1] = True
        with self.assertRaises(ValueError): self.validate()

    def test_unresolved_wave_and_boolean_counts_are_refused(self):
        self.witnesses[0]["evidence"]["wave_inflight"] = True
        with self.assertRaises(ValueError): self.validate()
        self.prepare("physical")
        self.witnesses[0]["evidence"]["completed"] = True
        with self.assertRaises(ValueError): self.validate()

    def test_foreign_witness_and_join_before_growth_are_refused(self):
        self.witnesses[0]["backing_generation"] = str(uuid.uuid4())
        with self.assertRaises(ValueError): self.validate()
        self.prepare("logical")
        self.witnesses[0], self.witnesses[1] = self.witnesses[1], self.witnesses[0]
        with self.assertRaises(ValueError): self.validate()

    def test_incoming_guest_is_different_and_original_join_is_required(self):
        self.prepare("logical")
        self.witnesses[0]["evidence"]["incoming_sandbox_id"] = self.events[1]["sandbox_id"]
        with self.assertRaises(ValueError): self.validate()
        self.prepare("logical")
        self.witnesses[1]["evidence"]["retirements"] = 0
        with self.assertRaises(ValueError): self.validate()

    def test_original_data_tail_wait_and_sample_windows_remain_required(self):
        for field in ("original_home_restored", "required_cleanup_joined"):
            self.prepare("physical")
            self.events[6]["evidence"][field] = False
            with self.assertRaises(ValueError): self.validate()
        self.prepare("physical")
        self.events[3]["evidence"]["positive_owned_wait"] = False
        with self.assertRaises(ValueError): self.validate()
        self.prepare("physical")
        self.events[4]["evidence"]["full_logical_lease"][-1] = True
        with self.assertRaises(ValueError): self.validate()
        self.prepare("physical")
        self.samples = [s for s in self.samples if not 50 <= s["monotonic_ns"] <= 60]
        with self.assertRaises(ValueError): self.validate()

    def test_partial_residency_remains_unknown_and_intervention_is_refused(self):
        for sample in self.samples[3:]:
            sample["processes"].append({"pid": 999, "start_ticks": 888, "rss_bytes": None, "pss_bytes": None,
                "residency_state": "unavailable", "residency_reason": "permission_denied",
                "observed_monotonic_ns": sample["monotonic_ns"], "exit_observed_monotonic_ns": None})
        self.assertFalse(self.validate()["residency_complete"])
        self.collector["cleanup_intervened"] = True
        with self.assertRaises(ValueError): self.validate()


if __name__ == "__main__":
    unittest.main()
