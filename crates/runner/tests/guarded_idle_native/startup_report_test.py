#!/usr/bin/env python3
"""Real-file/CLI refusal coverage for actual startup completion and read custody."""

import copy
import hashlib
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

import optional_report_test
import report
import startup_report as startup


class StartupReportTests(unittest.TestCase):
    def setUp(self):
        optional_report_test.OptionalReportTests.setUp(self)
        self.events, self.samples = self.events[:12], self.samples[:12]
        raw_policy, raw_inputs = json.dumps(self.policy), json.dumps(self.inputs)
        self.collector["metadata"].update(native_startup_policy_json=raw_policy,
            native_startup_inputs_json=raw_inputs, native_startup_snapshot_bytes=startup.BYTES)
        self.witnesses = []
        for offset, case in enumerate(sorted(startup.CASES)):
            terminal = self.events[offset*6:offset*6+6]
            for event in terminal:
                event["case"] = case
            def runtime(finished):
                return {**{key: 0 for key in ("accepted", "completed", "cancelled", "failed",
                    "uncertain", "deferred", "read_bytes")}, "last_error": None, "finished": finished}
            read = {"accepted": 1, "completed": 1, "cancelled": 0, "failed": 0,
                    "read_bytes": startup.BYTES, "last_error": None}
            values = [
                {"policy": self.policy, "inputs_sha256": hashlib.sha256(raw_inputs.encode()).hexdigest(),
                 "snapshot_sha256": self.artifacts["snapshot_files"]["memory.bin"],
                 "snapshot_bytes": startup.BYTES, "snapshot_memory_mb": 4096,
                 "prefetch_overhead_bytes": 1024**2, "allocated": [2, 4096, 1], "startup_pressure_guarded": False},
                {"state": "Unknown", "reads": runtime(False), "registered_operations": 0, "tracked_tasks": 0},
                {"startup": dict(read), "startup_drained": True, "state": "Unknown", "reads": runtime(False),
                 "allocated": [2, 4096, 1], "registered_operations": 0, "tracked_tasks": 0},
                {"startup": dict(read), "startup_drained": True, "reads": runtime(True), "runtime_drained": True,
                 "pressure_stopped": True, "producer_lost": False, "wave_inflight": False,
                 "snapshot_reverified": True, "registered_operations": 0, "tracked_tasks": 0},
            ]
            for index, (phase, evidence) in enumerate(zip(startup.PHASES, values), 1):
                clock = terminal[1]["monotonic_ns"]+index
                self.witnesses.append({"version": 1, "case": case, "phase": phase,
                    "monotonic_ns": clock, "unix_ns": clock+1000,
                    "sandbox_id": terminal[1]["sandbox_id"], "backing_generation": terminal[1]["backing_generation"],
                    "evidence": evidence})

    def write(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(s) for s in self.samples))
        (self.root/"stdout.log").write_text("\n".join(
            [report.PREFIX+json.dumps(e) for e in self.events]
            + [startup.PREFIX+json.dumps(e) for e in self.witnesses]))

    def validate(self):
        self.write()
        return startup.validate(self.root)

    def refused(self, mutations):
        original = copy.deepcopy(self.witnesses)
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.witnesses = copy.deepcopy(original)
                mutation()
                with self.assertRaises(ValueError):
                    self.validate()

    def test_two_modes_keep_production_admission_and_measurement_limits(self):
        result = self.validate()
        self.assertEqual(set(result["cases"]), startup.CASES)
        self.assertTrue(result["native_startup_corpus_complete"])
        for key in ("startup_pressure_guarded", "memory_envelope_calibrated", "production_protection_proven"):
            self.assertFalse(result[key])

    def test_cli_requires_complete_real_files_and_all_phases(self):
        self.write()
        command = [sys.executable, str(pathlib.Path(__file__).with_name("startup_report.py")), str(self.root)]
        self.assertEqual(json.loads(subprocess.check_output(command))["format"], "native-startup-phase-report-v1")
        self.witnesses.pop()
        self.write()
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_missing_duplicate_wrong_case_and_reordered_phases_fail(self):
        self.refused((lambda: self.witnesses.pop(2),
            lambda: self.witnesses.append(copy.deepcopy(self.witnesses[-1])),
            lambda: self.witnesses[0].update(case="Critical-fresh"),
            lambda: self.witnesses[1].update(monotonic_ns=self.witnesses[0]["monotonic_ns"])))

    def test_original_identity_and_join_before_retirement_are_required(self):
        self.refused((lambda: self.witnesses[2].update(backing_generation=str(uuid.uuid4())),
            lambda: self.witnesses[3].update(sandbox_id=str(uuid.uuid4())),
            lambda: self.witnesses[3].update(monotonic_ns=self.events[2]["monotonic_ns"]+1)))

    def test_exact_snapshot_hash_shape_input_and_full_lease_required(self):
        self.refused(tuple(lambda k=k, v=v: self.witnesses[0]["evidence"].update({k:v})
            for k,v in (("inputs_sha256", "0"*64), ("snapshot_sha256", "0"*64),
                        ("snapshot_bytes", 1), ("snapshot_memory_mb", True),
                        ("allocated", [2, 4096, True]), ("startup_pressure_guarded", True))))

    def test_partial_failed_cancelled_or_boolean_startup_counts_fail(self):
        self.refused(tuple(lambda i=i, k=k, v=v: self.witnesses[i]["evidence"]["startup"].update({k:v})
            for i in (2, 3) for k,v in (("accepted", True), ("completed", 0),
                ("cancelled", 1), ("failed", 1), ("read_bytes", 1024**2), ("last_error", "read failed"))))

    def test_guarded_runtime_must_remain_suppressed_until_join(self):
        self.refused(tuple(lambda i=i, k=k: self.witnesses[i]["evidence"]["reads"].update({k:1})
            for i in (1, 2, 3) for k in ("accepted", "completed", "cancelled", "failed",
                "uncertain", "deferred", "read_bytes")))

    def test_unknown_state_and_unchanged_original_full_lease_required(self):
        self.refused((lambda: self.witnesses[1]["evidence"].update(state="Ready"),
            lambda: self.witnesses[2]["evidence"].update(state="Critical"),
            lambda: self.witnesses[2]["evidence"].update(allocated=[0, 0, 0])))

    def test_all_read_pressure_and_physical_work_joins_required(self):
        self.refused(tuple(lambda k=k, v=v: self.witnesses[3]["evidence"].update({k:v})
            for k,v in (("startup_drained", False), ("runtime_drained", False),
                ("pressure_stopped", False), ("producer_lost", True), ("wave_inflight", True),
                ("snapshot_reverified", False), ("registered_operations", 1), ("tracked_tasks", 1))))

    def test_reader_finish_cannot_be_early_or_missing(self):
        self.refused((lambda: self.witnesses[1]["evidence"]["reads"].update(finished=True),
            lambda: self.witnesses[3]["evidence"]["reads"].update(finished=False),
            lambda: self.witnesses[2]["evidence"].update(startup_drained=False)))

    def test_policy_hash_and_duplicate_raw_policy_are_rejected(self):
        raw = self.collector["metadata"]["native_startup_policy_json"]
        for changed in (raw+" ", raw[:-1]+',"max_operations":8}'):
            self.collector["metadata"]["native_startup_policy_json"] = changed
            if changed != raw+" ":
                self.artifacts["policy_sha256"] = hashlib.sha256(changed.encode()).hexdigest()
            with self.assertRaises(ValueError):
                self.validate()

    def test_invalid_raw_input_shapes_and_boolean_policy_are_refused(self):
        for changed in (dict(self.inputs, snapshot_path="relative/memory.bin"),
                        dict(self.inputs, snapshot_path="/snapshot/../memory.bin"),
                        dict(self.inputs, snapshot_memory_mb=True),
                        dict(self.inputs, prefetch_overhead_bytes=1)):
            self.collector["metadata"]["native_startup_inputs_json"] = json.dumps(changed)
            with self.assertRaises(ValueError):
                self.validate()
        raw = json.dumps(dict(self.policy, max_operations=True))
        self.collector["metadata"]["native_startup_policy_json"] = raw
        self.artifacts["policy_sha256"] = hashlib.sha256(raw.encode()).hexdigest()
        with self.assertRaises(ValueError):
            self.validate()

    def test_input_metadata_shape_and_hash_are_bound(self):
        self.collector["metadata"]["native_startup_inputs_json"] += " "
        with self.assertRaises(ValueError):
            self.validate()

    def test_forced_cleanup_cannot_count_as_native_success(self):
        self.collector["cleanup_intervened"] = True
        with self.assertRaisesRegex(ValueError, "collector did not positively"):
            self.validate()


if __name__ == "__main__":
    unittest.main()
