#!/usr/bin/env python3
"""Real-file and CLI rejection coverage for concurrent guarded reader evidence."""

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
import shared_reads_report as shared
import startup_report as startup


class SharedReadsReportTests(unittest.TestCase):
    def setUp(self):
        optional_report_test.OptionalReportTests.setUp(self)
        self.events, self.samples = self.events[:12], self.samples[:12]
        raw_policy, raw_inputs = json.dumps(self.policy), json.dumps(self.inputs)
        self.collector["metadata"].update(native_shared_reads_policy_json=raw_policy,
            native_shared_reads_inputs_json=raw_inputs, native_shared_reads_snapshot_bytes=startup.BYTES)
        self.witnesses = []
        for offset, case in enumerate(sorted(shared.CASES)):
            terminal = self.events[offset*6:offset*6+6]
            for event in terminal:
                event["case"] = case
                event["monotonic_ns"] *= 10**9
                event["unix_ns"] = event["monotonic_ns"]+1000
            for sample in self.samples[offset*6:offset*6+6]:
                sample["monotonic_ns"] *= 10**9
                sample["processes"].append({"pid": 124, "start_ticks": 457,
                    "rss_bytes": None, "pss_bytes": None})
            base = terminal[1]["monotonic_ns"]

            def clock(ms):
                return base+ms*1_000_000

            def sample(ms):
                return {"started_ns": clock(ms), "finished_ns": clock(ms)+1000,
                    "read_start_offset_ns": ms*1_000_000, "available_bytes": 32*1024**3,
                    "age_ns": 20, "read_duration_ns": 10}

            def read(outcome):
                return {"accepted": int(outcome != "unknown"), "completed": int(outcome == "complete"),
                    "cancelled": int(outcome == "cancelled"), "failed": 0, "uncertain": 0,
                    "deferred": 0, "last_error": None, "finished": outcome in ("complete", "cancelled"),
                    "read_bytes": startup.BYTES if outcome == "complete" else 1024**2 if outcome == "cancelled" else 0}

            def accounting(readers):
                return {"registered_operations": readers, "started": readers,
                    "ordinary_growth_bytes": readers*(startup.BYTES+1024**2), "tracked_tasks": readers,
                    "cleanup_growth_bytes": 0, "uncertain": 0}

            runner = str(uuid.uuid4())
            heartbeat = {"receipt": {"received_ns": clock(360), "acknowledgement_status": 204,
                "state": {"runnerId": runner, "snapshotGeneration": 1, "snapshotSequence": 1,
                    "group": "native-foreground", "mode": "running", "allocatedVcpu": 2,
                    "allocatedMemoryMb": 4096}}, "send_joined": True, "completed_ns": clock(365)}
            observer = {"started_ns": clock(370), "completed_ns": clock(375), "available_bytes": 32*1024**3,
                "age_ns": 20, "read_duration_ns": 10, "joined": True}
            ready = [sample(50), sample(200)]
            values = [
                {"policy": self.policy, "inputs_sha256": hashlib.sha256(raw_inputs.encode()).hexdigest(),
                 "snapshot_sha256": self.artifacts["snapshot_files"]["memory.bin"], "snapshot_bytes": startup.BYTES,
                 "snapshot_memory_mb": 4096, "prefetch_overhead_bytes": 1024**2, "checkpoint_bytes": 1024**2,
                 "production_startup_integrated": False, "checkpoint_models_stalled_storage": False, "allocated": [2,4096,1]},
                {"state": "Unknown", "first": read("unknown"), "second": read("unknown"), "accounting": accounting(0)},
                {"state": "Ready", "available_bytes": 32*1024**3, "samples": ready,
                 "first": read("held"), "second": read("held"), "accounting": accounting(2),
                 "checkpoint_bytes": [1024**2]*2, "release_bytes_withheld": True, "allocated": [2,4096,1]},
                {"cancelled_ns": clock(350), "first_drain_dropped_ns": clock(351), "second_pending_ns": clock(352),
                 "first_drain_pending": True, "first_drain_dropped": True, "second_drain_pending": True,
                 "release_bytes_withheld": True, "accounting": accounting(2), "second": read("held"),
                 "heartbeat": heartbeat, "observer": observer, "allocated": [2,4096,1]},
                {"first": read("cancelled"), "second": read("held"), "release_ns": clock(410), "joined_ns": clock(450),
                 "physical_drain_joined": True, "accounting": accounting(1), "second_release_withheld": True,
                 "samples": ready+[sample(420)], "allocated": [2,4096,1]},
                {"first": read("cancelled"), "second": read("complete"), "release_ns": clock(510), "joined_ns": clock(600),
                 "physical_drain_joined": True, "accounting": accounting(0), "samples": ready+[sample(420),sample(550)],
                 "allocated": [2,4096,1]},
                {"first": read("cancelled"), "second": read("complete"), "readers_drained": True,
                 "pressure_stopped": True, "heartbeat_joined": True, "provider_joined": True, "peer_joined": True,
                 "snapshot_reverified": True, "accounting": accounting(0), "allocated": [2,4096,1]},
            ]
            for phase, value, ms in zip(shared.PHASES, values, (10,20,300,400,500,650,800)):
                self.witnesses.append({"version": 1, "case": case, "phase": phase, "monotonic_ns": clock(ms),
                    "unix_ns": clock(ms)+1000, "sandbox_id": terminal[1]["sandbox_id"],
                    "backing_generation": terminal[1]["backing_generation"], "evidence": copy.deepcopy(value)})

    def write(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(s) for s in self.samples))
        (self.root/"stdout.log").write_text("\n".join([report.PREFIX+json.dumps(e) for e in self.events]
            +[shared.PREFIX+json.dumps(e) for e in self.witnesses]))

    def validate(self):
        self.write()
        return shared.validate(self.root)

    def refused(self, mutations):
        original = copy.deepcopy(self.witnesses)
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.witnesses = copy.deepcopy(original)
                mutation()
                with self.assertRaises(ValueError):
                    self.validate()

    def test_both_modes_keep_component_and_measurement_limits(self):
        value = self.validate()
        self.assertEqual(set(value["cases"]), shared.CASES)
        self.assertTrue(value["native_shared_reads_complete"])
        for key in ("production_startup_integrated", "checkpoint_models_stalled_storage",
                    "residency_complete", "memory_envelope_calibrated", "production_protection_proven"):
            self.assertFalse(value[key])

    def test_cli_accepts_complete_files_and_rejects_missing_physical_join(self):
        self.write()
        command = [sys.executable, str(pathlib.Path(__file__).with_name("shared_reads_report.py")), str(self.root)]
        self.assertEqual(json.loads(subprocess.check_output(command))["format"], "native-shared-reads-report-v1")
        self.witnesses.pop()
        self.write()
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_original_shape_hash_full_lease_and_claim_limits_are_required(self):
        self.refused(tuple(lambda k=k,v=v: self.witnesses[0]["evidence"].update({k:v}) for k,v in (
            ("snapshot_bytes", 1), ("snapshot_sha256", "0"*64), ("inputs_sha256", "0"*64),
            ("allocated", [2,4096,True]), ("production_startup_integrated", True),
            ("checkpoint_models_stalled_storage", True), ("checkpoint_bytes", 1))))

    def test_aggregate_custody_cannot_release_the_peer_or_use_local_budgets(self):
        self.refused(tuple(lambda i=i,k=k,v=v: self.witnesses[i]["evidence"]["accounting"].update({k:v})
            for i,k,v in ((2,"registered_operations",1), (2,"ordinary_growth_bytes",startup.BYTES+1024**2),
                (3,"tracked_tasks",0), (4,"ordinary_growth_bytes",0), (4,"started",True), (5,"registered_operations",1))))

    def test_missing_pending_drain_partial_peer_bytes_and_cancel_propagation_fail(self):
        self.refused((lambda: self.witnesses[3]["evidence"].update(second_drain_pending=False),
            lambda: self.witnesses[4]["evidence"].update(second_release_withheld=False),
            lambda: self.witnesses[4]["evidence"]["second"].update(cancelled=1),
            lambda: self.witnesses[5]["evidence"]["second"].update(read_bytes=1024**2),
            lambda: self.witnesses[5]["evidence"]["first"].update(read_bytes=0),
            lambda: self.witnesses[2]["evidence"].update(checkpoint_bytes=[0,1024**2])))

    def test_missing_reordered_duplicate_or_foreign_original_witnesses_fail(self):
        self.refused((lambda: self.witnesses.pop(2), lambda: self.witnesses.append(copy.deepcopy(self.witnesses[-1])),
            lambda: self.witnesses[3].update(monotonic_ns=self.witnesses[2]["monotonic_ns"]),
            lambda: self.witnesses[4].update(backing_generation=str(uuid.uuid4())),
            lambda: self.witnesses[6].update(monotonic_ns=self.events[2]["monotonic_ns"]+1)))

    def test_ready_requires_sustained_fresh_actual_samples_and_aggregate_headroom(self):
        self.refused((lambda: self.witnesses[2]["evidence"].update(available_bytes=1024**2),
            lambda: self.witnesses[2]["evidence"]["samples"].pop(0),
            lambda: self.witnesses[2]["evidence"]["samples"][-1].update(available_bytes=None),
            lambda: self.witnesses[4]["evidence"]["samples"].pop(),
            lambda: self.witnesses[5]["evidence"]["samples"][-1].update(started_ns=1)))

    def test_each_dependency_join_and_real_heartbeat_observation_is_required(self):
        self.refused(tuple(lambda k=k: self.witnesses[6]["evidence"].update({k:False}) for k in
            ("readers_drained", "pressure_stopped", "heartbeat_joined", "provider_joined", "peer_joined", "snapshot_reverified"))
            +(lambda: self.witnesses[3]["evidence"]["heartbeat"]["receipt"].update(acknowledgement_status=500),
              lambda: self.witnesses[3]["evidence"]["observer"].update(joined=False)))

    def test_raw_policy_hash_input_and_forced_cleanup_cannot_be_relabelled(self):
        for key in ("native_shared_reads_policy_json", "native_shared_reads_inputs_json"):
            original = self.collector["metadata"][key]
            self.collector["metadata"][key] += " "
            with self.assertRaises(ValueError):
                self.validate()
            self.collector["metadata"][key] = original
        self.collector["cleanup_intervened"] = True
        with self.assertRaises(ValueError):
            self.validate()


if __name__ == "__main__":
    unittest.main()
