#!/usr/bin/env python3
"""Real-file/CLI refusal coverage for native Critical multiwave evidence."""

import copy
import hashlib
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

import critical_report as critical
import optional_report_test
import report


class CriticalReportTests(unittest.TestCase):
    def setUp(self):
        optional_report_test.OptionalReportTests.setUp(self)
        self.events = self.events[:12]
        self.samples = self.samples[:12]
        self.policy.update(critical_available_bytes=40*1024**3,
                           recovery_available_bytes=48*1024**3)
        raw_policy, raw_inputs = json.dumps(self.policy), json.dumps(self.inputs)
        self.artifacts["policy_sha256"] = hashlib.sha256(raw_policy.encode()).hexdigest()
        self.collector["metadata"].update(native_critical_policy_json=raw_policy,
            native_critical_inputs_json=raw_inputs, native_critical_snapshot_bytes=4*1024**3)
        self.witnesses = []
        for offset, case in enumerate(sorted(critical.CASES)):
            terminal = self.events[offset*6:offset*6+6]
            for event in terminal:
                event["case"] = case
                event["monotonic_ns"] *= 10**9
                event["unix_ns"] = event["monotonic_ns"]+1000
            for sample in self.samples[offset*6:offset*6+6]:
                sample["monotonic_ns"] *= 10**9
                for process in sample["processes"]:
                    process["observed_monotonic_ns"] = sample["monotonic_ns"]
            base = terminal[1]["monotonic_ns"]
            blanks = [{"sandbox_id": str(uuid.uuid4()), "backing_generation": str(uuid.uuid4())}
                      for _ in range(2)]
            def reads(finished=False):
                return {**{key: 0 for key in ("accepted", "completed", "cancelled", "failed",
                        "uncertain", "deferred", "read_bytes")}, "last_error": None, "finished": finished}
            values = [
                {"policy": self.policy, "inputs_sha256": hashlib.sha256(raw_inputs.encode()).hexdigest(),
                 "snapshot_sha256": self.artifacts["snapshot_files"]["memory.bin"],
                 "snapshot_bytes": 4*1024**3, "snapshot_memory_mb": 4096,
                 "prefetch_overhead_bytes": 1024**2, "blanks": blanks,
                 "allocated": [6, 12288, 3], "profile_can_fit": True},
                {"state": "Unknown", "reads": reads(), "registered_operations": 0, "tracked_tasks": 0},
                {"state": "Critical", "available_bytes": 32*1024**3, "wave_inflight": True, "reads": reads()},
            ]
            for index in range(1, 4):
                values.append({"index": index, "selected": 1, "completed": 1, "uncertain": 0,
                    "not_started": 0, "skipped": 0, "stop": None, "status_error": False,
                    "resolved": True, "state": "Critical", "available_bytes": 32*1024**3,
                    "allocated": [2*(3-index), 4096*(3-index), 3-index], "reads": reads()})
            samples = []
            for tick in range(62):
                started = base + 3*10**9 + tick*500_000_000
                samples.append({"started_ns": started, "finished_ns": started+1000,
                    "read_start_offset_ns": started-base, "available_bytes": 32*1024**3,
                    "age_ns": 20, "read_duration_ns": 10})
            values.append({"waves": 3, "reads": reads(True), "prefetch_drained": True,
                "pressure_stopped": True, "producer_lost": False, "wave_inflight": False,
                "blank_exits": [{"backing_generation": b["backing_generation"], "exit_confirmed": True} for b in blanks],
                "allocated": [0, 0, 0], "inventory_empty": True,
                "registered_operations": 0, "tracked_tasks": 0, "snapshot_reverified": True, "samples": samples})
            for phase, evidence, second in zip(critical.PHASES, values, (1, 2, 4, 6, 9, 32, 35)):
                clock = base+second*10**9
                if phase == "wave_completed": evidence["completion_observed_ns"] = clock-750_000_000
                self.witnesses.append({"version": 1, "case": case, "phase": phase,
                    "monotonic_ns": clock, "unix_ns": clock+1000,
                    "sandbox_id": terminal[1]["sandbox_id"], "backing_generation": terminal[1]["backing_generation"],
                    "evidence": evidence})

    def write(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(s) for s in self.samples))
        (self.root/"stdout.log").write_text("\n".join(
            [report.PREFIX+json.dumps(e) for e in self.events]
            + [critical.PREFIX+json.dumps(e) for e in self.witnesses]))

    def validate(self):
        self.write()
        return critical.validate(self.root)

    def refused(self, mutations):
        original = copy.deepcopy(self.witnesses)
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.witnesses = copy.deepcopy(original)
                mutation()
                with self.assertRaises(ValueError):
                    self.validate()

    def test_two_modes_keep_native_classification_limits(self):
        result = self.validate()
        self.assertEqual(set(result["cases"]), critical.CASES)
        self.assertTrue(result["native_critical_multiwave_complete"])
        self.assertFalse(result["memory_envelope_calibrated"])
        self.assertFalse(result["production_protection_proven"])
        self.assertFalse(result["cases"]["Critical-fresh"]["critical"]["numerical_shortage_or_relief_proven"])

    def test_cli_accepts_real_files_and_refuses_missing_wave(self):
        self.write()
        command = [sys.executable, str(pathlib.Path(__file__).with_name("critical_report.py")), str(self.root)]
        self.assertEqual(json.loads(subprocess.check_output(command))["format"], "native-critical-phase-report-v1")
        self.witnesses.pop(4)
        self.write()
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_wrong_identity_duplicate_phase_and_clock_fail(self):
        self.refused((lambda: self.witnesses[3].update(case="Pressure-fresh"),
            lambda: self.witnesses[3].update(backing_generation=str(uuid.uuid4())),
            lambda: self.witnesses.append(copy.deepcopy(self.witnesses[-1])),
            lambda: self.witnesses[4].update(monotonic_ns=self.witnesses[3]["monotonic_ns"])))

    def test_source_snapshot_shape_hash_and_full_leases_fail(self):
        self.refused(tuple(lambda k=k, v=v: self.witnesses[0]["evidence"].update({k: v})
            for k, v in (("inputs_sha256", "0"*64), ("snapshot_sha256", "0"*64),
                         ("snapshot_bytes", 1), ("snapshot_memory_mb", True),
                         ("allocated", [2, 4096, 1]), ("profile_can_fit", 1))))

    def test_blank_generation_reuse_and_missing_owner_fail(self):
        self.refused((lambda: self.witnesses[0]["evidence"]["blanks"].pop(),
            lambda: self.witnesses[0]["evidence"]["blanks"][0].update(backing_generation=self.events[1]["backing_generation"]),
            lambda: self.witnesses[0]["evidence"]["blanks"][1].update(sandbox_id=self.witnesses[0]["evidence"]["blanks"][0]["sandbox_id"])))

    def test_any_optional_physical_work_is_refused(self):
        self.refused(tuple(lambda i=i, k=k: self.witnesses[i]["evidence"]["reads"].update({k: 1})
            for i in range(1, 7) for k in ("accepted", "completed", "cancelled", "failed", "uncertain", "deferred", "read_bytes")))

    def test_unknown_queued_work_or_finished_reader_is_refused(self):
        self.refused((lambda: self.witnesses[1]["evidence"].update(registered_operations=1),
            lambda: self.witnesses[1]["evidence"].update(tracked_tasks=1),
            lambda: self.witnesses[1]["evidence"]["reads"].update(finished=True),
            lambda: self.witnesses[2]["evidence"].update(state="Ready")))

    def test_oversized_refused_skipped_or_uncertain_wave_fails(self):
        self.refused(tuple(lambda k=k, v=v: self.witnesses[3]["evidence"].update({k: v})
            for k, v in (("selected", 2), ("selected", True), ("completed", 0), ("uncertain", 1),
                         ("not_started", 1), ("skipped", 1), ("stop", "NoLongerCritical"),
                         ("status_error", True), ("resolved", False), ("allocated", [0, 0, 0]))))

    def test_actual_noncritical_unknown_and_replayed_samples_fail(self):
        self.refused((lambda: self.witnesses[6]["evidence"]["samples"][0].update(available_bytes=50*1024**3),
            lambda: self.witnesses[6]["evidence"]["samples"][0].update(available_bytes=None),
            lambda: self.witnesses[6]["evidence"]["samples"][1].update(read_start_offset_ns=self.witnesses[6]["evidence"]["samples"][0]["read_start_offset_ns"]),
            lambda: self.witnesses[6]["evidence"].update(samples=[])))

    def test_stale_or_fabricated_decision_fails(self):
        self.refused((lambda: self.witnesses[3]["evidence"].update(available_bytes=31*1024**3),
            lambda: self.witnesses[3]["evidence"].update(available_bytes=True),
            lambda: self.witnesses[6]["evidence"]["samples"].__setitem__(slice(None), self.witnesses[6]["evidence"]["samples"][:3]),
            lambda: self.witnesses[6]["evidence"]["samples"][0].update(age_ns=10**12)))

    def test_precompletion_read_cannot_revalidate_wave(self):
        self.refused((lambda: self.witnesses[3]["evidence"].update(completion_observed_ns=self.witnesses[3]["monotonic_ns"]-1),
            lambda: self.witnesses[3]["evidence"].pop("completion_observed_ns")))

    def test_physical_and_logical_join_omissions_fail(self):
        self.refused(tuple(lambda k=k, v=v: self.witnesses[6]["evidence"].update({k: v})
            for k, v in (("prefetch_drained", False), ("pressure_stopped", False),
                         ("producer_lost", True), ("wave_inflight", True), ("blank_exits", []),
                         ("allocated", [2, 4096, 1]), ("inventory_empty", False),
                         ("registered_operations", 1), ("tracked_tasks", 1), ("snapshot_reverified", False))))

    def test_positive_blank_exit_and_final_reader_join_are_required(self):
        self.refused((lambda: self.witnesses[6]["evidence"]["blank_exits"][0].update(exit_confirmed=False),
            lambda: self.witnesses[6]["evidence"]["reads"].update(finished=False),
            lambda: self.witnesses[6]["evidence"]["reads"].update(last_error="lost observer"),
            lambda: self.witnesses[5].update(monotonic_ns=self.events[3]["monotonic_ns"]+1)))

    def test_policy_and_input_metadata_identity_are_bound(self):
        self.collector["metadata"]["native_critical_policy_json"] += " "
        with self.assertRaisesRegex(ValueError, "policy/hash"):
            self.validate()

    def test_boolean_wave_bound_and_duplicate_policy_are_refused(self):
        for raw in (json.dumps(dict(self.policy, pressure_max_wave_entries=True)),
                    json.dumps(self.policy)[:-1]+',"pressure_max_wave_entries":1}'):
            self.collector["metadata"]["native_critical_policy_json"] = raw
            self.artifacts["policy_sha256"] = hashlib.sha256(raw.encode()).hexdigest()
            with self.assertRaises(ValueError): self.validate()

    def test_collector_intervention_is_not_native_success(self):
        self.collector["cleanup_intervened"] = True
        with self.assertRaisesRegex(ValueError, "collector did not positively"):
            self.validate()


if __name__ == "__main__":
    unittest.main()
