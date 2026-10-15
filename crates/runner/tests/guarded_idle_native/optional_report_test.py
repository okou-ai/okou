#!/usr/bin/env python3
"""Real-file/CLI regressions for native optional read and ownership acceptance."""

import copy
import hashlib
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

import optional_report as optional
import report
import report_test


class OptionalReportTests(unittest.TestCase):
    def setUp(self):
        report_test.NativeReportTests.setUp(self)
        self.events = self.events[:24]
        self.samples = self.samples[:24]
        gib = 1024**3
        self.policy = {
            "host_total_bytes": 64*gib, "operating_floor_bytes": gib,
            "cleanup_reserve_bytes": 256*1024**2,
            "critical_available_bytes": 12*gib, "recovery_available_bytes": 20*gib,
            "live_growth_bytes": 4*1024**2, "tail_growth_bytes": 65*1024**2,
            "replacement_preparation_bytes": 32*1024**2, "max_sample_age_millis": 1000,
            "max_operations": 8, "max_cleanup_inflight": 2,
            "pressure_sample_period_millis": 50, "pressure_recovery_sustain_millis": 100,
            "pressure_wave_cooldown_millis": 100,
            "pressure_optional_start_interval_millis": 100, "pressure_max_wave_entries": 1,
        }
        self.inputs = {"snapshot_path": "/synthetic/snapshot/memory.bin",
                       "snapshot_memory_mb": 4096, "prefetch_overhead_bytes": 1024**2}
        raw_policy, raw_inputs = json.dumps(self.policy), json.dumps(self.inputs)
        self.artifacts["policy_sha256"] = hashlib.sha256(raw_policy.encode()).hexdigest()
        self.collector["metadata"].update(
            native_optional_policy_json=raw_policy, native_optional_inputs_json=raw_inputs,
            native_optional_snapshot_bytes=4*gib)
        self.witnesses = []
        for offset, case in enumerate(sorted(optional.CASES)):
            events = self.events[offset*6:offset*6+6]
            for event in events:
                event["case"] = case
            aged = case.startswith("OptionalAged-")
            original = {
                "policy": self.policy,
                "optional_inputs_sha256": hashlib.sha256(raw_inputs.encode()).hexdigest(),
                "snapshot_sha256": self.artifacts["snapshot_files"]["memory.bin"],
                "snapshot_bytes": 4*gib, "snapshot_memory_mb": 4096,
                "prefetch_overhead_bytes": 1024**2, "allocated": [2, 4096, 1], "aged": aged,
            }
            accepted = {"state": "Ready", "wave_inflight": False,
                        "available_bytes": 32*gib, "age_ns": 2, "read_duration_ns": 1,
                        "allocated": [2, 4096, 1]}
            prepared = {"prepared": True, "published": True, "retired_exact": aged,
                        "finished": True, "retained_resource": False, "error": None}
            joined = {"accepted": 1, "completed": 1, "cancelled": 0, "failed": 0,
                      "uncertain": 0, "read_bytes": 4*gib, "finished": True,
                      "pressure_stopped": True, "producer_lost": False,
                      "prefetch_drained": True, "blank_shutdown_joined": True}
            start = events[1]["monotonic_ns"]
            clocks = (start+1, start+2,
                      events[4]["monotonic_ns"]+1 if aged else start+3,
                      events[4]["monotonic_ns"]+2 if aged else start+4)
            for phase, evidence, clock in zip(optional.PHASES,
                                              (original, accepted, prepared, joined), clocks):
                self.witnesses.append({
                    "version": 1, "case": case, "phase": phase, "monotonic_ns": clock,
                    "unix_ns": clock+1000, "sandbox_id": events[1]["sandbox_id"],
                    "backing_generation": events[1]["backing_generation"], "evidence": evidence})

    def write(self):
        (self.root / "report.json").write_text(json.dumps(self.collector))
        (self.root / "samples.jsonl").write_text("\n".join(json.dumps(s) for s in self.samples))
        (self.root / "stdout.log").write_text("\n".join(
            [report.PREFIX+json.dumps(e) for e in self.events]
            + [optional.PREFIX+json.dumps(e) for e in self.witnesses]))

    def validate(self):
        self.write()
        return optional.validate(self.root)

    def test_four_modes_accept_complete_reads_and_keep_measurement_limits(self):
        result = self.validate()
        self.assertEqual(set(result["cases"]), optional.CASES)
        self.assertTrue(result["native_optional_ready_corpus_complete"])
        self.assertFalse(result["memory_envelope_calibrated"])
        self.assertFalse(result["production_protection_proven"])
        self.assertNotIn("native_terminal_corpus_complete", result)

    def test_cli_accepts_real_files_and_rejects_missing_read_join(self):
        self.write()
        command = [sys.executable, str(pathlib.Path(__file__).with_name("optional_report.py")),
                   str(self.root)]
        result = subprocess.run(command, capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)["format"], "native-optional-phase-report-v1")
        self.witnesses.pop()
        self.write()
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_missing_duplicate_wrong_mode_and_unordered_evidence_fail(self):
        original = copy.deepcopy(self.witnesses)
        for mutation in (lambda: self.witnesses.pop(),
                         lambda: self.witnesses.append(copy.deepcopy(self.witnesses[-1])),
                         lambda: self.witnesses[0].update(case="Pressure-fresh"),
                         lambda: self.witnesses[1].update(monotonic_ns=self.witnesses[0]["monotonic_ns"])):
            self.witnesses = copy.deepcopy(original)
            mutation()
            with self.assertRaises(ValueError):
                self.validate()

    def test_exact_raw_optional_input_and_original_snapshot_identity_required(self):
        original = copy.deepcopy(self.witnesses)
        for key, value in (("optional_inputs_sha256", "0"*64), ("snapshot_sha256", "1"*64),
                           ("snapshot_bytes", 1), ("snapshot_memory_mb", 1),
                           ("prefetch_overhead_bytes", 1), ("allocated", [2, 4096, True])):
            with self.subTest(key=key):
                self.witnesses = copy.deepcopy(original)
                self.witnesses[0]["evidence"][key] = value
                with self.assertRaises(ValueError):
                    self.validate()

    def test_fresh_fitting_ready_condition_and_real_read_cost_required(self):
        original = copy.deepcopy(self.witnesses)
        for key, value in (("state", "Critical"), ("wave_inflight", True),
                           ("available_bytes", 1), ("age_ns", 10**12),
                           ("read_duration_ns", 3), ("allocated", [2, 4096, 2])):
            with self.subTest(key=key):
                self.witnesses = copy.deepcopy(original)
                self.witnesses[1]["evidence"][key] = value
                with self.assertRaises(ValueError):
                    self.validate()

    def test_preparation_publication_and_exact_aged_outcome_required(self):
        original = copy.deepcopy(self.witnesses)
        for key, value in (("prepared", False), ("published", False), ("retired_exact", False),
                           ("finished", False), ("retained_resource", True), ("error", "lost")):
            self.witnesses = copy.deepcopy(original)
            self.witnesses[2]["evidence"][key] = value
            with self.assertRaises(ValueError):
                self.validate()

    def test_positive_partial_read_cannot_substitute_for_complete_snapshot(self):
        self.witnesses[3]["evidence"]["read_bytes"] = 1024**2
        with self.assertRaisesRegex(ValueError, "complete original read"):
            self.validate()

    def test_read_failures_and_all_physical_producer_joins_are_enforced(self):
        original = copy.deepcopy(self.witnesses)
        for key, value in (("accepted", True), ("completed", 0), ("cancelled", 1),
                           ("failed", 1), ("uncertain", 1), ("finished", False),
                           ("pressure_stopped", False), ("producer_lost", True),
                           ("prefetch_drained", False), ("blank_shutdown_joined", False)):
            self.witnesses = copy.deepcopy(original)
            self.witnesses[3]["evidence"][key] = value
            with self.assertRaises(ValueError):
                self.validate()

    def test_cross_generation_and_original_required_tail_cannot_be_replaced(self):
        self.witnesses[2]["backing_generation"] = str(uuid.uuid4())
        with self.assertRaises(ValueError):
            self.validate()
        self.witnesses[2]["backing_generation"] = self.events[1]["backing_generation"]
        self.events[3]["evidence"]["full_logical_lease"] = [2, 2048, 1]
        with self.assertRaises(ValueError):
            self.validate()

    def test_raw_policy_input_shape_and_boolean_measurements_fail_closed(self):
        metadata = copy.deepcopy(self.collector["metadata"])
        for key, value in (("native_optional_policy_json", metadata["native_optional_policy_json"]+" "),
                           ("native_optional_inputs_json", '{"snapshot_memory_mb":4096}'),
                           ("native_optional_snapshot_bytes", True),
                           ("native_optional_snapshot_bytes", 5*1024**3)):
            self.collector["metadata"] = dict(metadata, **{key: value})
            with self.assertRaises(ValueError):
                self.validate()
        self.collector["metadata"] = metadata
        self.witnesses[0]["evidence"]["policy"] = dict(self.policy, pressure_max_wave_entries=True)
        with self.assertRaises(ValueError):
            self.validate()

    def test_unconfirmed_collector_cleanup_and_missing_samples_fail(self):
        self.collector["cleanup_intervened"] = True
        with self.assertRaises(ValueError):
            self.validate()
        self.collector["cleanup_intervened"] = False
        self.samples.clear()
        with self.assertRaises(ValueError):
            self.validate()


if __name__ == "__main__":
    unittest.main()
