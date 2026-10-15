#!/usr/bin/env python3
"""Real-file/CLI refusal regressions for native observation recovery evidence."""

import copy
import hashlib
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

import optional_report_test
import recovery_report as recovery
import report


class RecoveryReportTests(unittest.TestCase):
    def setUp(self):
        optional_report_test.OptionalReportTests.setUp(self)
        self.events = self.events[:12]
        self.samples = self.samples[:12]
        self.policy["pressure_optional_start_interval_millis"] = 10000
        raw_policy = json.dumps(self.policy)
        raw_inputs = json.dumps(self.inputs)
        self.artifacts["policy_sha256"] = hashlib.sha256(raw_policy.encode()).hexdigest()
        self.collector["metadata"].update(native_recovery_policy_json=raw_policy,
            native_recovery_inputs_json=raw_inputs, native_recovery_snapshot_bytes=4*1024**3)
        self.witnesses = []
        for offset, case in enumerate(sorted(recovery.CASES)):
            terminal = self.events[offset*6:offset*6+6]
            for event in terminal:
                event["case"] = case
                event["monotonic_ns"] *= 10**10
                event["unix_ns"] = event["monotonic_ns"]+1000
            for sample in self.samples[offset*6:offset*6+6]:
                sample["monotonic_ns"] = (sample["monotonic_ns"]-1)*10**10+1
            base = terminal[1]["monotonic_ns"]
            def clock(seconds):
                return base+int(seconds*10**9)
            def decision(state, reason=None):
                return {"state": state, "available_bytes": None if state == "Unknown" else 32*1024**3,
                        "unknown": f"Observation({reason})" if reason else None, "wave_inflight": False}
            source = []
            for seconds in [*[2.1+i*.1 for i in range(23)], 6.2, 6.3, 6.4, 7.2, 9.8,
                            *[13.1+i*.1 for i in range(19)], 15.5, 18.5, 20.5]:
                source.append({"started_ns": clock(seconds), "finished_ns": clock(seconds)+1000,
                    "read_start_offset_ns": clock(seconds)-base,
                    "available_bytes": 32*1024**3, "age_ns": 20, "read_duration_ns": 10})
            values = [
                {"policy": self.policy, "inputs_sha256": hashlib.sha256(raw_inputs.encode()).hexdigest(),
                 "snapshot_sha256": self.artifacts["snapshot_files"]["memory.bin"],
                 "snapshot_bytes": 4*1024**3, "snapshot_memory_mb": 4096,
                 "prefetch_overhead_bytes": 1024**2, "distinct_verified_copies": 2, "allocated": [2, 4096, 1]},
                decision("Unknown", "NotObserved"), decision("Recovering"), decision("Ready"),
                decision("Unknown", "Stale"),
                {"fresh_grant_joined": True, "old_offer_valid": False, "physical_work_started": False, "recovered_ready": True},
                {"elapsed_ns": 3_400_000_000, "fresh_read_since_offer": True, "second_offer": False},
                decision("Unknown", "Stale"), decision("Recovering"), decision("Unknown", "Stale"),
                {"accepted": 0, "registered_operations": 0, "tracked_tasks": 0}, decision("Recovering"), decision("Ready"),
                {"accepted": 1, "completed": 0, "read_bytes": 0},
                {"accepted": 2, "completed": 1, "read_bytes": 4*1024**3},
                {"accepted": 2, "completed": 2, "cancelled": 0, "failed": 0, "uncertain": 0,
                 "read_bytes": 8*1024**3, "finished": True, "prefetch_drained": True,
                 "deferred": 0, "last_error": None,
                 "pressure_stopped": True, "producer_lost": False, "admission_joined": True,
                 "copies_reverified": True, "samples": source},
            ]
            seconds = (1, 2, 3, 4, 6, 7, 7.5, 9, 10, 12, 13, 14, 15, 16, 19, 22)
            for phase, evidence, second in zip(recovery.PHASES, values, seconds):
                self.witnesses.append({"version": 1, "case": case, "phase": phase,
                    "monotonic_ns": clock(second), "unix_ns": clock(second)+1000,
                    "sandbox_id": terminal[1]["sandbox_id"],
                    "backing_generation": terminal[1]["backing_generation"], "evidence": evidence})

    def write(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(s) for s in self.samples))
        (self.root/"stdout.log").write_text("\n".join(
            [report.PREFIX+json.dumps(e) for e in self.events]
            + [recovery.PREFIX+json.dumps(e) for e in self.witnesses]))

    def validate(self):
        self.write()
        return recovery.validate(self.root)

    def test_two_modes_require_actual_gaps_recovery_and_complete_reads(self):
        result = self.validate()
        self.assertEqual(set(result["cases"]), recovery.CASES)
        self.assertTrue(result["native_observation_recovery_complete"])
        self.assertFalse(result["memory_envelope_calibrated"])
        self.assertFalse(result["production_protection_proven"])
        self.assertFalse(result["cases"]["Recovery-fresh"]["recovery"]["physical_acceptance_clocks_are_offer_clocks"])

    def test_cli_accepts_files_and_rejects_missing_revocation(self):
        self.write()
        command = [sys.executable, str(pathlib.Path(__file__).with_name("recovery_report.py")), str(self.root)]
        self.assertEqual(json.loads(subprocess.check_output(command))["format"], "native-recovery-phase-report-v1")
        self.witnesses.pop(5)
        self.write()
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_wrong_phase_original_generation_and_duplicate_evidence_fail(self):
        original = copy.deepcopy(self.witnesses)
        for mutation in (lambda: self.witnesses[4].update(case="OptionalOrdinary-fresh"),
                         lambda: self.witnesses[4].update(backing_generation=str(uuid.uuid4())),
                         lambda: self.witnesses.append(copy.deepcopy(self.witnesses[-1])),
                         lambda: self.witnesses[4].update(monotonic_ns=self.witnesses[3]["monotonic_ns"])):
            self.witnesses = copy.deepcopy(original)
            mutation()
            with self.assertRaises(ValueError): self.validate()

    def test_supplied_input_hash_partial_snapshot_and_boolean_shape_fail(self):
        original = copy.deepcopy(self.witnesses)
        for key, value in (("inputs_sha256", "0"*64), ("snapshot_sha256", "0"*64),
                           ("snapshot_bytes", 1), ("distinct_verified_copies", True), ("allocated", [2, True, 1])):
            self.witnesses = copy.deepcopy(original)
            self.witnesses[0]["evidence"][key] = value
            with self.assertRaises(ValueError): self.validate()

    def test_actual_stale_reason_fresh_recovery_and_no_inflight_wave_required(self):
        original = copy.deepcopy(self.witnesses)
        for index, key, value in ((4, "unknown", "Observation(NotObserved)"),
                                  (8, "state", "Ready"), (12, "available_bytes", 1),
                                  (12, "wave_inflight", True)):
            self.witnesses = copy.deepcopy(original)
            self.witnesses[index]["evidence"][key] = value
            with self.assertRaises(ValueError): self.validate()

    def test_waited_fresh_grant_cannot_revive_offer_or_start_physical_work(self):
        original = copy.deepcopy(self.witnesses)
        for key, value in (("fresh_grant_joined", False), ("old_offer_valid", True),
                           ("physical_work_started", True), ("physical_work_started", 0),
                           ("recovered_ready", False)):
            self.witnesses = copy.deepcopy(original)
            self.witnesses[5]["evidence"][key] = value
            with self.assertRaises(ValueError): self.validate()

    def test_fresh_read_cannot_bypass_shared_cadence(self):
        for key, value in (("elapsed_ns", 10_000_000_000), ("fresh_read_since_offer", False), ("second_offer", True)):
            original = self.witnesses[6]["evidence"].copy()
            self.witnesses[6]["evidence"][key] = value
            with self.assertRaises(ValueError): self.validate()
            self.witnesses[6]["evidence"] = original

    def test_replayed_or_short_or_stale_recovery_samples_fail(self):
        original = copy.deepcopy(self.witnesses[15]["evidence"]["samples"])
        for replacement in (original[:1]+original[:1]+original[2:],
                            [s for s in original if not self.witnesses[10]["monotonic_ns"] < s["started_ns"] < self.witnesses[12]["monotonic_ns"]],
                            [dict(s, age_ns=10**9) for s in original]):
            self.witnesses[15]["evidence"]["samples"] = replacement
            with self.assertRaises(ValueError): self.validate()

    def test_extra_burst_read_or_missing_post_wait_sample_fail(self):
        original = copy.deepcopy(self.witnesses[15]["evidence"]["samples"])
        burst = next(s for s in original if self.witnesses[7]["monotonic_ns"] < s["started_ns"] < self.witnesses[9]["monotonic_ns"])
        extra = dict(burst, started_ns=burst["started_ns"]+2000,
                     finished_ns=burst["finished_ns"]+2000,
                     read_start_offset_ns=burst["read_start_offset_ns"]+2000)
        for replacement in (sorted(original+[extra], key=lambda s: s["started_ns"]),
                            [s for s in original if not self.witnesses[4]["monotonic_ns"] < s["started_ns"] < self.witnesses[5]["monotonic_ns"]]):
            self.witnesses[15]["evidence"]["samples"] = replacement
            with self.assertRaises(ValueError): self.validate()

    def test_partial_reads_failures_and_unjoined_owners_fail(self):
        original = copy.deepcopy(self.witnesses)
        for index, key, value in ((10, "accepted", 1), (13, "accepted", 2),
                                  (10, "registered_operations", 1), (10, "tracked_tasks", 1),
                                  (15, "read_bytes", 1024**2), (15, "uncertain", 1),
                                  (15, "deferred", 1), (15, "last_error", "resource changed"),
                                  (15, "prefetch_drained", False), (15, "pressure_stopped", False),
                                  (15, "admission_joined", False), (15, "copies_reverified", False)):
            self.witnesses = copy.deepcopy(original)
            self.witnesses[index]["evidence"][key] = value
            with self.assertRaises(ValueError): self.validate()

    def test_original_required_tail_and_collector_completion_remain_strict(self):
        self.events[3]["evidence"]["full_logical_lease"] = [2, 2048, 1]
        with self.assertRaises(ValueError): self.validate()
        self.events[3]["evidence"]["full_logical_lease"] = [2, 4096, 1]
        self.collector["cleanup_intervened"] = True
        with self.assertRaises(ValueError): self.validate()

    def test_unknown_residency_stays_an_explicit_lower_bound(self):
        self.samples[1]["processes"].append({"pid": 999, "start_ticks": 888, "rss_bytes": None, "pss_bytes": None})
        self.assertFalse(self.validate()["residency_complete"])

    def test_raw_policy_tampering_and_duplicate_keys_fail(self):
        metadata = self.collector["metadata"]
        original = metadata["native_recovery_policy_json"]
        metadata["native_recovery_policy_json"] += " "
        with self.assertRaises(ValueError): self.validate()
        duplicate = original[:-1]+', "max_operations": 8}'
        metadata["native_recovery_policy_json"] = duplicate
        self.artifacts["policy_sha256"] = hashlib.sha256(duplicate.encode()).hexdigest()
        with self.assertRaises(ValueError): self.validate()

    def test_overflowing_read_envelope_is_refused_before_native_acceptance(self):
        self.inputs["prefetch_overhead_bytes"] = 2**64-1
        self.collector["metadata"]["native_recovery_inputs_json"] = json.dumps(self.inputs)
        with self.assertRaisesRegex(ValueError, "cannot fit supplied bounds"):
            self.validate()


if __name__ == "__main__":
    unittest.main()
