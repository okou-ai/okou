#!/usr/bin/env python3
"""Real-file/CLI refusals for pressure shutdown with independently held File IO."""

import copy
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

import read_stop_report as stopped
import report
import shared_reads_report_test
import startup_report as startup


class ReadStopReportTests(unittest.TestCase):
    refused = shared_reads_report_test.SharedReadsReportTests.refused

    def setUp(self):
        shared_reads_report_test.SharedReadsReportTests.setUp(self)
        for key in ("policy_json", "inputs_json", "snapshot_bytes"):
            self.collector["metadata"]["native_read_stop_"+key] = self.collector["metadata"]["native_shared_reads_"+key]
        previous, self.witnesses = self.witnesses, []
        for offset, case in enumerate(sorted(stopped.CASES)):
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

            held = {"samples": old[2]["samples"], "first": old[2]["first"], "second": old[2]["second"],
                "accounting": accounting(2), "release_bytes_withheld": True,
                "explicit_old_cancel_requested": False, "allocated": [2,4096,1]}
            refused = copy.deepcopy(old[1]["first"])
            refused["finished"] = True
            heartbeat, observer = copy.deepcopy(old[3]["heartbeat"]), copy.deepcopy(old[3]["observer"])
            heartbeat["receipt"]["received_ns"] = clock(440)
            heartbeat["completed_ns"] = clock(450)
            observer.update(started_ns=clock(455), completed_ns=clock(460))
            waiting = {**held, "shutdown_requested_ns": clock(410), "shutdown_pending_ns": clock(420),
                "readers_pending_ns": clock(430), "shutdown_still_pending_ns": clock(470),
                "shutdown_pending": True, "controller_stopped": True, "sampler_release_withheld": True,
                "first_drain_pending": True, "second_drain_pending": True, "drain_observers_dropped": True,
                "optional_closed": True, "refused": refused, "heartbeat": heartbeat, "observer": observer}
            joined = {**held, "observation_released_ns": clock(520), "pressure_joined_ns": clock(550),
                "controller_joined": True, "sampler_joined": True, "producer_lost": False, "wave_inflight": False,
                "optional_closed": True, "refused": refused, "samples": held["samples"]+[sample(530)]}
            reads = []
            for index, remaining in enumerate((1,0)):
                reads.append({"read": old[4]["first"], "release_ns": clock(620+index*100),
                    "joined_ns": clock(650+index*100), "physical_drain_joined": True, "optional_closed": True,
                    "samples": joined["samples"]+[sample(630+i*100) for i in range(index+1)],
                    "accounting": accounting(remaining), "explicit_old_cancel_requested": False, "allocated": [2,4096,1]})
            done = {"first": reads[0]["read"], "second": reads[1]["read"], "refused": refused,
                "controller_joined": True, "sampler_joined": True, "readers_drained": True,
                "heartbeat_joined": True, "provider_joined": True, "peer_joined": True, "snapshot_reverified": True,
                "optional_closed": True, "explicit_old_cancel_requested": False,
                "accounting": accounting(0), "allocated": [2,4096,1]}
            values = [old[0],old[1],old[2],held,waiting,joined,*reads,done]
            for phase, value, ms in zip(stopped.PHASES, values, (10,20,300,350,500,600,700,800,900)):
                self.witnesses.append({"version": 1, "case": case, "phase": phase, "monotonic_ns": clock(ms),
                    "unix_ns": clock(ms)+1000, "sandbox_id": terminal[1]["sandbox_id"],
                    "backing_generation": terminal[1]["backing_generation"], "evidence": copy.deepcopy(value)})

    def write(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(s) for s in self.samples))
        (self.root/"stdout.log").write_text("\n".join([report.PREFIX+json.dumps(e) for e in self.events]
            +[stopped.PREFIX+json.dumps(e) for e in self.witnesses]))

    def validate(self):
        self.write()
        return stopped.validate(self.root)

    def test_both_modes_keep_separate_evidence_and_claim_limits(self):
        value = self.validate()
        self.assertEqual(set(value["cases"]), stopped.CASES)
        self.assertEqual(value["format"], "native-read-stop-report-v1")
        self.assertTrue(value["native_read_stop_complete"])
        for key in ("production_startup_integrated", "checkpoint_models_stalled_storage",
                    "residency_complete", "memory_envelope_calibrated", "production_protection_proven"):
            self.assertFalse(value[key])

    def test_cli_accepts_complete_files_and_refuses_missing_shutdown_join(self):
        self.write()
        command = [sys.executable, str(pathlib.Path(__file__).with_name("read_stop_report.py")), str(self.root)]
        self.assertTrue(json.loads(subprocess.check_output(command))["native_read_stop_complete"])
        self.witnesses.pop(5)
        self.write()
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_original_hash_full_lease_policy_types_and_limits_are_required(self):
        self.refused(tuple(lambda k=k,v=v: self.witnesses[0]["evidence"].update({k:v}) for k,v in (
            ("snapshot_sha256","0"*64), ("snapshot_bytes",1), ("inputs_sha256","0"*64),
            ("allocated",[2,4096,True]), ("production_startup_integrated",True))))

    def test_original_ready_admission_and_full_allowances_are_required(self):
        self.refused((lambda: self.witnesses[2]["evidence"]["samples"].pop(),
            lambda: self.witnesses[2]["evidence"].update(available_bytes=1),
            lambda: self.witnesses[2]["evidence"]["accounting"].update(ordinary_growth_bytes=0)))

    def test_shutdown_cannot_discharge_independent_reader_allowances(self):
        self.refused(tuple(lambda i=i,k=k,v=v: self.witnesses[i]["evidence"]["accounting"].update({k:v})
            for i,k,v in ((3,"registered_operations",1), (4,"tracked_tasks",0), (5,"ordinary_growth_bytes",0),
                (6,"registered_operations",0), (7,"started",True))))

    def test_shutdown_pending_and_both_dropped_reader_observers_are_required(self):
        self.refused(tuple(lambda k=k: self.witnesses[4]["evidence"].update({k:False}) for k in
            ("shutdown_pending","controller_stopped","sampler_release_withheld","first_drain_pending",
                "second_drain_pending","drain_observers_dropped")))

    def test_pending_foreground_clocks_and_acknowledgements_are_required(self):
        self.refused((lambda: self.witnesses[4]["evidence"].update(shutdown_still_pending_ns=1),
            lambda: self.witnesses[4]["evidence"]["observer"].update(joined=False),
            lambda: self.witnesses[4]["evidence"]["heartbeat"]["receipt"].update(acknowledgement_status=500)))

    def test_held_observation_cannot_be_renewed_during_shutdown_wait(self):
        self.refused((lambda: self.witnesses[4]["evidence"]["samples"].pop(),
            lambda: self.witnesses[4]["evidence"]["samples"][-1].update(age_ns=0)))

    def test_pressure_join_requires_actual_source_release_and_sampler_completion(self):
        self.refused((lambda: self.witnesses[5]["evidence"].update(controller_joined=False),
            lambda: self.witnesses[5]["evidence"].update(sampler_joined=False),
            lambda: self.witnesses[5]["evidence"].update(producer_lost=True),
            lambda: self.witnesses[5]["evidence"].update(observation_released_ns=self.witnesses[5]["monotonic_ns"]),
            lambda: self.witnesses[5]["evidence"]["samples"].pop()))

    def test_stopped_capability_and_new_reader_remain_refused_before_and_after_join(self):
        self.refused((lambda: self.witnesses[4]["evidence"]["refused"].update(accepted=1),
            lambda: self.witnesses[5]["evidence"]["refused"].update(read_bytes=1),
            lambda: self.witnesses[5]["evidence"].update(optional_closed=False),
            lambda: self.witnesses[7]["evidence"].update(optional_closed=False)))

    def test_original_cancelled_bytes_cannot_be_replaced_by_completion_or_manual_cancel(self):
        self.refused((lambda: self.witnesses[5]["evidence"]["first"].update(completed=1),
            lambda: self.witnesses[6]["evidence"]["read"].update(read_bytes=startup.BYTES),
            lambda: self.witnesses[7]["evidence"]["read"].update(cancelled=True),
            lambda: self.witnesses[4]["evidence"].update(explicit_old_cancel_requested=True)))

    def test_each_physical_join_needs_fresh_post_release_settlement(self):
        self.refused((lambda: self.witnesses[6]["evidence"]["samples"].pop(),
            lambda: self.witnesses[7]["evidence"].update(physical_drain_joined=False),
            lambda: self.witnesses[7]["evidence"].update(joined_ns=self.witnesses[6]["monotonic_ns"])))

    def test_all_dependency_joins_are_required_before_original_saving(self):
        self.refused(tuple(lambda k=k: self.witnesses[8]["evidence"].update({k:False}) for k in
            ("controller_joined","sampler_joined","readers_drained","heartbeat_joined",
                "provider_joined","peer_joined","snapshot_reverified")))

    def test_missing_duplicate_reordered_or_foreign_phases_fail(self):
        self.refused((lambda: self.witnesses.pop(5), lambda: self.witnesses.append(copy.deepcopy(self.witnesses[-1])),
            lambda: self.witnesses[5].update(monotonic_ns=self.witnesses[4]["monotonic_ns"]),
            lambda: self.witnesses[6].update(backing_generation=str(uuid.uuid4()))))

    def test_raw_inputs_and_forced_cleanup_cannot_be_relabelled(self):
        key = "native_read_stop_inputs_json"
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
