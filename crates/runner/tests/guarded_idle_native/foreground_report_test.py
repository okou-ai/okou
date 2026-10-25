#!/usr/bin/env python3
"""Real-file/CLI refusals for actual foreground progress and physical custody."""

import copy
import hashlib
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

import foreground_report as foreground
import optional_report_test
import report
import startup_report as startup


class ForegroundReportTests(unittest.TestCase):
    def setUp(self):
        optional_report_test.OptionalReportTests.setUp(self)
        for event in self.events:
            event["monotonic_ns"] *= 100_000_000
            event["unix_ns"] *= 100_000_000
        for sample in self.samples:
            sample["monotonic_ns"] *= 100_000_000
            for process in sample["processes"]:
                process["observed_monotonic_ns"] = sample["monotonic_ns"]
        raw_policy, raw_inputs = json.dumps(self.policy), json.dumps(self.inputs)
        self.collector["metadata"].update(native_foreground_policy_json=raw_policy,
            native_foreground_inputs_json=raw_inputs, native_foreground_snapshot_bytes=startup.BYTES)
        self.witnesses = []
        read = {"accepted": 1, "completed": 1, "cancelled": 0, "failed": 0,
                "read_bytes": startup.BYTES, "last_error": None}
        runtime = {**read, "uncertain": 0, "deferred": 0, "finished": True}
        unknown = {**{k: 0 for k in runtime if k not in ("last_error", "finished")},
                   "last_error": None, "finished": False}
        for offset, case in enumerate(sorted(foreground.CASES)):
            terminal = self.events[offset*6:offset*6+6]
            for event in terminal:
                event["case"] = case
            start = terminal[1]["monotonic_ns"]
            tail = terminal[3]["monotonic_ns"]
            kind = "Fresh" if case.startswith("ForegroundFresh-") else "Reuse"
            runner = str(uuid.uuid4())
            def observation(begin):
                return {"started_ns": begin+10_000_000, "completed_ns": begin+20_000_000,
                    "available_bytes": 32*1024**3, "age_ns": 2, "read_duration_ns": 1, "joined": True}
            def heartbeat(sequence, begin):
                return {"receipt": {"received_ns": begin+10_000_000, "acknowledgement_status": 204,
                    "state": {"runnerId": runner, "snapshotGeneration": 1, "snapshotSequence": sequence,
                        "group": "native-foreground", "mode": "running", "allocatedVcpu": 2,
                        "allocatedMemoryMb": 4096}}, "send_joined": True, "completed_ns": begin+20_000_000}
            samples = [{"started_ns": start+delta, "finished_ns": start+delta+3,
                "read_start_offset_ns": delta, "available_bytes": 32*1024**3,
                "age_ns": 2, "read_duration_ns": 1} for delta in (120_000_000, 240_000_000, 360_000_000)]
            values = [
                {"policy": self.policy, "inputs_sha256": hashlib.sha256(raw_inputs.encode()).hexdigest(),
                 "snapshot_sha256": self.artifacts["snapshot_files"]["memory.bin"], "snapshot_bytes": startup.BYTES,
                 "snapshot_memory_mb": 4096, "prefetch_overhead_bytes": 1024**2,
                 "allocated": [2,4096,1], "startup_pressure_guarded": False, "kind": kind},
                {"startup": dict(read), "startup_drained": True, "reads": dict(unknown), "state": "Unknown",
                 "pool_held": True, "status_held": True, "heartbeat_received": False,
                 "foreground_pool_wait_polled": True,
                 "pool_held_ns": start+20_000_000, "status_held_ns": start+30_000_000,
                 "observer": observation(start+35_000_000)},
                {"state": "Ready", "available_bytes": 32*1024**3, "status_held": True,
                 "heartbeat": heartbeat(1,start+120_000_000), "observer": observation(start+150_000_000),
                 "reads": dict(runtime), "runtime_drained": True, "status_held_ns": start+30_000_000,
                 "pool_released_ns": start+110_000_000, "samples": samples,
                 "status_wait_polled_ns": start+115_000_000,
                 "foreground_status_wait_polled": True},
                {"kind": kind, "sandbox_id": str(uuid.uuid4()) if kind == "Fresh" else terminal[1]["sandbox_id"],
                 "run_id": str(uuid.uuid4()), "operation_id": str(uuid.uuid4()), "guest_rpc_completed": True,
                 "phase_settled": True, "original_owner_preserved": True, "allocated": [2,4096,1]},
                {"kernel_io_entered": True, "release_byte_withheld": True, "full_original_lease": [2,4096,1],
                 "allocated": [2,4096,1], "heartbeat": heartbeat(2,tail+10_000_000),
                 "observer": observation(tail+40_000_000)},
                {"startup": dict(read), "reads": dict(runtime), "startup_drained": True, "runtime_drained": True,
                 "foreground_joined": True, "pressure_stopped": True, "producer_lost": False,
                 "wave_inflight": False, "heartbeat_joined": True, "provider_joined": True, "peer_joined": True,
                 "snapshot_reverified": True, "allocated": [0,0,0], "registered_operations": 0, "tracked_tasks": 0},
            ]
            clocks = (start+10_000_000, start+100_000_000, start+500_000_000,
                      start+600_000_000, tail+100_000_000, terminal[4]["monotonic_ns"]+100_000_000)
            for phase, evidence, clock in zip(foreground.PHASES, values, clocks):
                self.witnesses.append({"version": 1, "case": case, "phase": phase,
                    "monotonic_ns": clock, "unix_ns": clock+1000,
                    "sandbox_id": terminal[1]["sandbox_id"], "backing_generation": terminal[1]["backing_generation"],
                    "evidence": evidence})

    def write(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(s) for s in self.samples))
        (self.root/"stdout.log").write_text("\n".join([report.PREFIX+json.dumps(e) for e in self.events]
            + [foreground.PREFIX+json.dumps(e) for e in self.witnesses]))

    def validate(self):
        self.write()
        return foreground.validate(self.root)

    def refused(self, changes):
        original = copy.deepcopy(self.witnesses)
        for change in changes:
            with self.subTest(change=change):
                self.witnesses = copy.deepcopy(original)
                change()
                with self.assertRaises(ValueError):
                    self.validate()

    def test_all_four_modes_keep_claim_limits(self):
        result = self.validate()
        self.assertEqual(set(result["cases"]), foreground.CASES)
        self.assertTrue(result["native_foreground_progress_complete"])
        for key in ("startup_pressure_guarded", "memory_envelope_calibrated", "production_protection_proven"):
            self.assertFalse(result[key])

    def test_cli_requires_all_real_files_and_phases(self):
        self.write()
        command = [sys.executable,str(pathlib.Path(__file__).with_name("foreground_report.py")),str(self.root)]
        self.assertEqual(json.loads(subprocess.check_output(command))["format"], "native-foreground-phase-report-v1")
        self.witnesses.pop()
        self.write()
        self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)

    def recovery_policy(self, freshness=200, sustain=240):
        self.policy.update(max_sample_age_millis=freshness,
            pressure_recovery_sustain_millis=sustain)
        raw = json.dumps(self.policy)
        self.collector["metadata"]["native_foreground_policy_json"] = raw
        self.artifacts["policy_sha256"] = hashlib.sha256(raw.encode()).hexdigest()

    def test_cli_accepts_sustained_history_with_only_the_latest_read_still_fresh(self):
        self.recovery_policy()
        # Three reads span 240 ms, with 120 ms gaps; only the last is still
        # within the 200 ms bound at the decision. Historical reads were fresh.
        self.write()
        command = [sys.executable, str(pathlib.Path(__file__).with_name("foreground_report.py")), str(self.root)]
        result = json.loads(subprocess.check_output(command))
        self.assertTrue(result["native_foreground_progress_complete"])
        self.assertEqual(set(result["cases"]), foreground.CASES)
        self.assertFalse(result["memory_envelope_calibrated"])
        self.assertFalse(result["production_protection_proven"])

    def test_ready_resets_on_unknown_critical_or_interrupted_recovery(self):
        self.recovery_policy()
        self.refused(tuple(lambda value=value: self.witnesses[2]["evidence"]["samples"][1].update(
            available_bytes=value) for value in (None, self.policy["critical_available_bytes"],
                self.policy["recovery_available_bytes"]-1)))

    def test_read_start_gap_at_freshness_bound_cannot_sustain_ready(self):
        self.recovery_policy(freshness=240)
        # Retaining just the endpoints used to manufacture sustained recovery
        # across a gap at the expiry boundary.
        self.witnesses[2]["evidence"]["samples"].pop(1)
        with self.assertRaisesRegex(ValueError, "lacks distinct sustained"):
            self.validate()

    def test_current_observation_must_still_be_fresh(self):
        self.recovery_policy(freshness=139)
        with self.assertRaisesRegex(ValueError, "lacks distinct sustained"):
            self.validate()

    def test_observation_already_expired_when_read_cannot_sustain_ready(self):
        self.recovery_policy()
        sample = self.witnesses[2]["evidence"]["samples"][1]
        sample.update(finished_ns=sample["started_ns"]+201_000_000, age_ns=201_000_000)
        with self.assertRaisesRegex(ValueError, "lacks distinct sustained"):
            self.validate()

    def test_coherent_history_cannot_claim_an_unfinished_recovery(self):
        self.recovery_policy(sustain=241)
        with self.assertRaisesRegex(ValueError, "lacks distinct sustained"):
            self.validate()

    def test_ready_rejects_read_offsets_outside_the_actual_monotonic_intervals(self):
        self.recovery_policy()
        self.witnesses[2]["evidence"]["samples"][1]["read_start_offset_ns"] += 1_000_000
        with self.assertRaisesRegex(ValueError, "offsets contradict"):
            self.validate()

    def test_completed_recovery_survives_the_hysteresis_band(self):
        self.recovery_policy(sustain=100)
        samples = self.witnesses[2]["evidence"]["samples"]
        middle = copy.deepcopy(samples[1])
        for key in ("started_ns", "finished_ns", "read_start_offset_ns"):
            middle[key] += 60_000_000
        middle["available_bytes"] = self.policy["recovery_available_bytes"]-1
        samples.insert(2, middle)
        self.assertTrue(self.validate()["native_foreground_progress_complete"])

    def test_missing_duplicate_wrong_case_and_order_fail(self):
        self.refused((lambda:self.witnesses.pop(2), lambda:self.witnesses.append(copy.deepcopy(self.witnesses[-1])),
            lambda:self.witnesses[0].update(case="Startup-fresh"),
            lambda:self.witnesses[4].update(monotonic_ns=self.events[4]["monotonic_ns"]+1)))

    def test_original_inputs_identity_and_full_lease_required(self):
        self.refused((lambda:self.witnesses[0]["evidence"].update(snapshot_bytes=1),
            lambda:self.witnesses[0]["evidence"].update(inputs_sha256="0"*64),
            lambda:self.witnesses[0]["evidence"].update(allocated=[2,4096,True]),
            lambda:self.witnesses[3].update(backing_generation=str(uuid.uuid4()))))

    def test_partial_failed_cancelled_or_boolean_reads_are_refused(self):
        self.refused(tuple(lambda i=i,k=k,v=v:self.witnesses[i]["evidence"]["startup"].update({k:v})
            for i in (1,5) for k,v in (("completed",0),("accepted",True),("failed",1),("cancelled",1),("read_bytes",1))))
        self.refused(tuple(lambda i=i,k=k,v=v:self.witnesses[i]["evidence"]["reads"].update({k:v})
            for i in (2,5) for k,v in (("completed",0),("uncertain",1),("last_error","read failed"),("finished",False))))

    def test_initial_unknown_cannot_have_optional_work(self):
        self.refused((lambda:self.witnesses[1]["evidence"]["reads"].update(accepted=1),
            lambda:self.witnesses[1]["evidence"].update(state="Ready")))

    def test_observer_must_be_a_new_read_joined_inside_each_wait(self):
        self.refused(tuple(lambda i=i,k=k,v=v:self.witnesses[i]["evidence"]["observer"].update({k:v})
            for i in (1,2,4) for k,v in (("joined",False),("started_ns",1),("available_bytes",None),("age_ns",6_000_000_000))))

    def test_heartbeat_needs_actual_acknowledgement_sequence_and_join(self):
        self.refused((lambda:self.witnesses[2]["evidence"]["heartbeat"]["receipt"].update(acknowledgement_status=500),
            lambda:self.witnesses[2]["evidence"]["heartbeat"].update(send_joined=False),
            lambda:self.witnesses[4]["evidence"]["heartbeat"]["receipt"]["state"].update(snapshotSequence=True),
            lambda:self.witnesses[4]["evidence"]["heartbeat"]["receipt"]["state"].update(runnerId=str(uuid.uuid4()))))

    def test_wait_and_delivery_clocks_cannot_be_replayed(self):
        self.refused((lambda:self.witnesses[2]["evidence"].update(pool_released_ns=1),
            lambda:self.witnesses[2]["evidence"].update(status_held_ns=1),
            lambda:self.witnesses[2]["evidence"]["heartbeat"]["receipt"].update(received_ns=1)))

    def test_spawned_work_without_a_polled_real_wait_is_refused(self):
        self.refused((lambda:self.witnesses[1]["evidence"].update(foreground_pool_wait_polled=False),
            lambda:self.witnesses[2]["evidence"].update(foreground_status_wait_polled=False)))

    def test_progress_before_the_actual_status_wait_is_refused(self):
        status = self.witnesses[2]["evidence"]
        early = status["status_wait_polled_ns"]-1
        self.refused((lambda:self.witnesses[2]["evidence"].pop("status_wait_polled_ns"),
            lambda:self.witnesses[2]["evidence"].update(status_wait_polled_ns=True),
            lambda:self.witnesses[2]["evidence"]["heartbeat"]["receipt"].update(received_ns=early),
            lambda:self.witnesses[2]["evidence"]["observer"].update(started_ns=early),
            lambda:self.witnesses[2]["evidence"]["samples"][0].update(started_ns=early)))

    def test_ready_requires_distinct_fresh_actual_pressure_observations(self):
        def expired():
            for sample in self.witnesses[2]["evidence"]["samples"]:
                sample.update(age_ns=10_000_000_000)
        self.refused((lambda:self.witnesses[2]["evidence"].update(samples=[]),
            lambda:self.witnesses[2]["evidence"].update(available_bytes=1),
            expired,
            lambda:self.witnesses[2]["evidence"].update(state="Critical")))

    def test_real_fresh_or_original_reuse_guest_completion_required(self):
        self.refused((lambda:self.witnesses[3]["evidence"].update(sandbox_id=self.events[1]["sandbox_id"]),
            lambda:self.witnesses[3]["evidence"].update(guest_rpc_completed=False),
            lambda:self.witnesses[15]["evidence"].update(sandbox_id=str(uuid.uuid4())),
            lambda:self.witnesses[3]["evidence"].update(phase_settled=False)))

    def test_blocked_io_preserves_full_original_custody(self):
        self.refused((lambda:self.witnesses[4]["evidence"].update(release_byte_withheld=False),
            lambda:self.witnesses[4]["evidence"].update(kernel_io_entered=False),
            lambda:self.witnesses[4]["evidence"].update(full_original_lease=[0,0,0])))

    def test_every_started_owner_and_physical_dependency_must_join(self):
        self.refused(tuple(lambda k=k,v=v:self.witnesses[5]["evidence"].update({k:v}) for k,v in (
            ("foreground_joined",False),("pressure_stopped",False),("producer_lost",True),("wave_inflight",True),
            ("heartbeat_joined",False),("provider_joined",False),("peer_joined",False),
            ("snapshot_reverified",False),("registered_operations",1),("tracked_tasks",1))))

    def test_exact_raw_input_and_policy_binding_is_required(self):
        self.collector["metadata"]["native_foreground_inputs_json"] += " "
        with self.assertRaises(ValueError): self.validate()

    def test_duplicate_or_forged_pressure_read_boundaries_are_refused(self):
        self.refused((lambda:self.witnesses[2]["evidence"]["samples"].append(
            copy.deepcopy(self.witnesses[2]["evidence"]["samples"][-1])),
            lambda:self.witnesses[2]["evidence"]["samples"][0].update(available_bytes=2**64),
            lambda:self.witnesses[2]["evidence"]["samples"][0].update(read_duration_ns=100)))

    def test_forced_cleanup_cannot_certify_native_progress(self):
        self.collector["cleanup_intervened"] = True
        with self.assertRaisesRegex(ValueError,"collector did not positively"): self.validate()


if __name__ == "__main__":
    unittest.main()
