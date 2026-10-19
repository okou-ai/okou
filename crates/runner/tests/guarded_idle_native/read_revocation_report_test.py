#!/usr/bin/env python3
"""Real-file/CLI refusals for accepted reads across stale recovery."""

import copy
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

import read_revocation_report as revocation
import report
import shared_reads_report_test
import startup_report as startup


class ReadRevocationReportTests(unittest.TestCase):
    refused = shared_reads_report_test.SharedReadsReportTests.refused

    def setUp(self):
        shared_reads_report_test.SharedReadsReportTests.setUp(self)
        for key in ("policy_json", "inputs_json", "snapshot_bytes"):
            self.collector["metadata"]["native_read_revocation_"+key] = self.collector["metadata"]["native_shared_reads_"+key]
        previous, self.witnesses = self.witnesses, []
        for offset, case in enumerate(sorted(revocation.CASES)):
            terminal = self.events[offset*6:offset*6+6]
            for event in terminal:
                event["case"] = case
            old = [e["evidence"] for e in previous[offset*7:offset*7+7]]
            base = terminal[1]["monotonic_ns"]

            def clock(ms):
                return base+ms*1_000_000

            def sample(ms):
                return {"started_ns": clock(ms), "finished_ns": clock(ms)+1000,
                    "read_start_offset_ns": ms*1_000_000, "available_bytes": 32*1024**3,
                    "age_ns": 20, "read_duration_ns": 10}

            def accounting(readers):
                return {"registered_operations": readers, "started": readers,
                    "ordinary_growth_bytes": readers*(startup.BYTES+1024**2), "tracked_tasks": readers,
                    "cleanup_growth_bytes": 0, "uncertain": 0}

            held = {"first": old[2]["first"], "second": old[2]["second"], "samples": old[2]["samples"],
                "accounting": accounting(2), "release_bytes_withheld": True,
                "explicit_old_cancel_requested": False, "allocated": [2,4096,1]}
            stale = {**held, "state": "Unknown", "reason": "Stale"}
            waiting = copy.deepcopy(old[3])
            waiting.pop("cancelled_ns")
            waiting.update(stale, first_drain_dropped_ns=clock(1320), second_pending_ns=clock(1330))
            waiting.update(peer_pending_ns=clock(1340), peer_drain_pending=True)
            waiting["heartbeat"]["receipt"]["received_ns"] = clock(1360)
            waiting["heartbeat"]["completed_ns"] = clock(1365)
            waiting["observer"].update(started_ns=clock(1370), completed_ns=clock(1375))
            recovered = {**held, "state": "Ready", "available_bytes": 32*1024**3,
                "resumed_ns": clock(1410), "samples": held["samples"]+[sample(1450),sample(1600)]}
            fresh = {**recovered, "fresh": old[2]["second"], "checkpoint_bytes": [1024**2]*3,
                "accounting": accounting(3)}
            fresh.pop("resumed_ns")
            joined = []
            for index, remaining in enumerate((2,1,0)):
                joined.append({"first": old[2 if index == 0 else 4]["first"],
                    "second": old[2]["second"] if remaining else old[4]["first"], "fresh": old[5]["second"],
                    "release_ns": clock(1810+index*100), "joined_ns": clock(1850+index*100),
                    "release_state": "Ready", "release_available_bytes": 32*1024**3,
                    "state": "Ready", "available_bytes": 32*1024**3,
                    "physical_drain_joined": True, "samples": recovered["samples"]+[sample(1830+i*100) for i in range(index+1)],
                    "accounting": accounting(remaining), "explicit_old_cancel_requested": False, "allocated": [2,4096,1]})
            done = {k:joined[-1][k] for k in ("first","second","fresh","accounting","allocated","explicit_old_cancel_requested")}
            done.update(readers_drained=True, pressure_stopped=True, heartbeat_joined=True,
                provider_joined=True, peer_joined=True, snapshot_reverified=True)
            values = [old[0],old[1],old[2],held,stale,waiting,recovered,fresh,*joined,done]
            for phase, value, ms in zip(revocation.PHASES, values, (10,20,300,350,1300,1400,1700,1800,1900,2000,2100,2200)):
                self.witnesses.append({"version": 1, "case": case, "phase": phase, "monotonic_ns": clock(ms),
                    "unix_ns": clock(ms)+1000, "sandbox_id": terminal[1]["sandbox_id"],
                    "backing_generation": terminal[1]["backing_generation"], "evidence": copy.deepcopy(value)})

    def write(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(s) for s in self.samples))
        (self.root/"stdout.log").write_text("\n".join([report.PREFIX+json.dumps(e) for e in self.events]
            +[revocation.PREFIX+json.dumps(e) for e in self.witnesses]))

    def validate(self):
        self.write()
        return revocation.validate(self.root)

    def test_both_modes_preserve_component_and_measurement_limits(self):
        value = self.validate()
        self.assertEqual(set(value["cases"]), revocation.CASES)
        self.assertTrue(value["native_read_revocation_complete"])
        for key in ("production_startup_integrated", "checkpoint_models_stalled_storage",
                    "residency_complete", "memory_envelope_calibrated", "production_protection_proven"):
            self.assertFalse(value[key])

    def test_cli_accepts_complete_files_and_refuses_lost_join(self):
        self.write()
        command = [sys.executable, str(pathlib.Path(__file__).with_name("read_revocation_report.py")), str(self.root)]
        self.assertEqual(json.loads(subprocess.check_output(command))["format"], "native-read-revocation-report-v1")
        self.witnesses.pop()
        self.write()
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_frozen_samples_must_remain_original_and_actually_expire(self):
        self.refused((lambda: self.witnesses[3]["evidence"]["samples"].pop(),
            lambda: self.witnesses[4]["evidence"]["samples"][-1].update(age_ns=0),
            lambda: self.witnesses[4].update(monotonic_ns=self.witnesses[3]["monotonic_ns"]+1),
            lambda: self.witnesses[5]["evidence"]["samples"][-1].update(read_start_offset_ns=1)))

    def test_recovery_requires_distinct_actual_post_resume_sustained_samples(self):
        self.refused((lambda: self.witnesses[6]["evidence"]["samples"].pop(),
            lambda: self.witnesses[6]["evidence"].update(resumed_ns=self.witnesses[6]["monotonic_ns"]),
            lambda: self.witnesses[6]["evidence"]["samples"][-1].update(available_bytes=None),
            lambda: self.witnesses[7]["evidence"].update(available_bytes=1024**2)))

    def test_newer_admission_observation_must_expire_before_stale_witness(self):
        value = copy.deepcopy(self.witnesses[3]["evidence"]["samples"][-1])
        for key in ("started_ns", "finished_ns", "read_start_offset_ns"):
            value[key] += 120_000_000
        for index in (3,4,5):
            self.witnesses[index]["evidence"]["samples"].append(copy.deepcopy(value))
        with self.assertRaisesRegex(ValueError, "real observation expiry"):
            self.validate()

    def test_three_full_allowances_and_individual_physical_release_are_required(self):
        self.refused(tuple(lambda i=i,k=k,v=v: self.witnesses[i]["evidence"]["accounting"].update({k:v})
            for i,k,v in ((3,"ordinary_growth_bytes",0), (5,"tracked_tasks",0), (7,"registered_operations",2),
                (8,"ordinary_growth_bytes",0), (9,"started",True), (10,"registered_operations",1))))

    def test_each_physical_join_requires_fresh_post_release_observation(self):
        self.refused(tuple(lambda i=i: self.witnesses[i]["evidence"]["samples"].pop() for i in (8,9,10)))

    def test_old_read_releases_require_witnessed_recovered_ready(self):
        self.refused((lambda: self.witnesses[9]["evidence"].update(state="Critical"),
            lambda: self.witnesses[10]["evidence"].update(release_state="Unknown"),
            lambda: self.witnesses[9]["evidence"].update(release_available_bytes=1024**2),
            lambda: self.witnesses[10]["evidence"].update(available_bytes=None)))

    def test_recovery_cannot_revive_old_reads_or_substitute_voluntary_cancel(self):
        self.refused((lambda: self.witnesses[5]["evidence"].update(explicit_old_cancel_requested=True),
            lambda: self.witnesses[9]["evidence"].update(explicit_old_cancel_requested=True),
            lambda: self.witnesses[6]["evidence"]["first"].update(cancelled=1),
            lambda: self.witnesses[9]["evidence"]["first"].update(read_bytes=startup.BYTES),
            lambda: self.witnesses[10]["evidence"]["second"].update(completed=1)))

    def test_new_read_must_be_accepted_and_complete_all_original_bytes(self):
        self.refused((lambda: self.witnesses[7]["evidence"]["fresh"].update(accepted=0),
            lambda: self.witnesses[7]["evidence"].update(checkpoint_bytes=[1024**2]*2),
            lambda: self.witnesses[8]["evidence"]["fresh"].update(read_bytes=1024**2),
            lambda: self.witnesses[8]["evidence"].update(physical_drain_joined=False)))

    def test_pending_observers_and_independent_foreground_progress_are_required(self):
        self.refused((lambda: self.witnesses[5]["evidence"].update(second_drain_pending=False),
            lambda: self.witnesses[5]["evidence"].update(peer_drain_pending=False),
            lambda: self.witnesses[5]["evidence"]["heartbeat"]["receipt"].update(acknowledgement_status=500),
            lambda: self.witnesses[5]["evidence"]["observer"].update(joined=False),
            lambda: self.witnesses[5]["evidence"].update(second_pending_ns=self.witnesses[5]["monotonic_ns"])))

    def test_original_inputs_identity_full_lease_and_claim_limits_are_required(self):
        self.refused(tuple(lambda k=k,v=v: self.witnesses[0]["evidence"].update({k:v}) for k,v in (
            ("snapshot_bytes",1), ("snapshot_sha256","0"*64), ("inputs_sha256","0"*64),
            ("allocated",[2,4096,True]), ("production_startup_integrated",True), ("checkpoint_models_stalled_storage",True))))

    def test_missing_duplicate_reordered_or_foreign_phases_fail(self):
        self.refused((lambda: self.witnesses.pop(4), lambda: self.witnesses.append(copy.deepcopy(self.witnesses[-1])),
            lambda: self.witnesses[5].update(monotonic_ns=self.witnesses[4]["monotonic_ns"]),
            lambda: self.witnesses[8].update(backing_generation=str(uuid.uuid4()))))

    def test_all_dependency_joins_are_required_before_original_saving(self):
        self.refused(tuple(lambda k=k: self.witnesses[11]["evidence"].update({k:False}) for k in
            ("readers_drained","pressure_stopped","heartbeat_joined","provider_joined","peer_joined","snapshot_reverified")))

    def test_raw_inputs_policy_and_forced_cleanup_cannot_be_relabelled(self):
        for key in ("native_read_revocation_policy_json", "native_read_revocation_inputs_json"):
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
