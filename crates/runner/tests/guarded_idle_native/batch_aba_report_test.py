#!/usr/bin/env python3
"""Synthetic real-file/CLI batch-ABA reader regressions, never native proof."""

import copy
import hashlib
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

import batch_aba_report as aba
import cleanup_report as cleanup
import report
import status_failure_report_test as failure_test


class BatchAbaReportTests(unittest.TestCase):
    def setUp(self):
        failure_test.StatusFailureReportTests.setUp(self)
        raw = json.dumps(self.policy)
        self.collector["metadata"].pop("native_status_failure_policy_json")
        self.collector["metadata"]["native_batch_aba_policy_json"] = raw
        self.artifacts["policy_sha256"] = hashlib.sha256(raw.encode()).hexdigest()
        originals, sample = self.events, self.samples[0]
        self.events, self.samples, self.witnesses = [], [], []
        for index, case in enumerate(sorted(aba.CASES)):
            at = lambda offset: 10_000_000_000*(index+1)+offset*1_000_000
            terminal = copy.deepcopy(originals[index*6:index*6+6])
            for event, offset in zip(terminal, (0,1,36,37,46,60)):
                event.update(case=case, monotonic_ns=at(offset), unix_ns=at(offset)+1000)
                reading = copy.deepcopy(sample)
                reading["monotonic_ns"] = at(offset)+1
                reading["processes"][0]["observed_monotonic_ns"] = at(offset)+1
                self.samples.append(reading)
            self.events.extend(terminal)
            old, backing = terminal[1]["sandbox_id"], terminal[1]["backing_generation"]
            runner = str(uuid.uuid4())
            zero = dict.fromkeys(cleanup.COUNTS, 0) | {"closed": False}
            queued = zero | {"registered_operations": 2, "queued": 2}
            active = zero | {"registered_operations": 1, "started": 1, "tracked_tasks": 1,
                             "cleanup_growth_bytes": self.policy["tail_growth_bytes"]}
            reuse = "thread:native-guarded-"+str(uuid.uuid4())
            initial = {"mode":"starting","max_concurrent":1,"active_runs":[],
                "started_at":"2026-10-19T02:00:00Z","updated_at":"2026-10-19T02:00:01Z",
                "idle_sandboxes":[{"reuse_key":reuse,"sandbox_id":old}]}
            current = initial | {"updated_at":"2026-10-19T02:00:02Z"}
            empty = {k:v for k,v in current.items() if k != "idle_sandboxes"}
            empty["updated_at"] = "2026-10-19T02:00:03Z"
            def observer(start, end):
                return {"started_ns":at(start),"completed_ns":at(end),"available_bytes":32*1024**3,
                        "age_ns":2,"read_duration_ns":1,"joined":True}
            def heartbeat(sequence, start, end):
                return {"receipt":{"received_ns":at(start),"acknowledgement_status":204,
                    "state":{"runnerId":runner,"snapshotGeneration":1,"snapshotSequence":sequence,
                        "group":"native-foreground","mode":"running","allocatedVcpu":2,"allocatedMemoryMb":4096}},
                    "send_joined":True,"completed_ns":at(end)}
            values = (
                {"policy":self.policy,"status_path":str(self.root/f"case-{index}"/"status.json"),
                    "published_status":initial,"selected_revision":1,"source_read_blocked":True,
                    "receiver_polled_pending":True,"accounting":queued,"allocated":[2,4096,1],
                    "original_full_lease_active":True,"original_exit_polled_pending":True},
                {"pool_held_ns":at(4),"status_held_ns":at(5),"reserved_ns":at(6),"restored_ns":at(7),
                    "revision":3,"original_sandbox_id":old,"original_backing_generation":backing,
                    "same_insertion":False,"restored_original":True,"heartbeat_pending_ns":at(8),
                    "heartbeat_polled_pending":True,"observer":observer(9,10),"accounting":queued,"allocated":[2,4096,1]},
                {"pool_released_ns":at(13),"heartbeat":heartbeat(1,14,15),"receiver_polled_pending":True,
                    "source_read_blocked":True,"accounting":queued,"allocated":[2,4096,1]},
                {"source_resumed_ns":at(18),"status_wait_polled_ns":at(23),"status_waits_before":0,
                    "status_waits_after":1,"accounting":zero,"samples":[{"started_ns":at(begin),
                        "finished_ns":at(end),"read_start_offset_ns":at(begin),"available_bytes":32*1024**3,
                        "age_ns":2,"read_duration_ns":1} for begin,end in ((19,20),(21,22))],
                    "heartbeat":heartbeat(2,24,25),"receiver_polled_pending":True,"original_full_lease_active":True,
                    "original_exit_polled_pending":True,"allocated":[2,4096,1]},
                {"status_released_ns":at(29),"batch_joined_ns":at(30),"selected":1,"completed":0,"uncertain":0,
                    "not_started":1,"status_error":False,"is_complete":False,"refusal_sandbox_id":old,
                    "refusal_reuse_key":reuse,"refusal_error":"ResourceChanged","revision":3,
                    "published_status":current,"regular_file":True,"original_exit_polled_pending":True,
                    "original_full_lease_active":True,"allocated":[2,4096,1]},
                {"recovery_started_ns":at(35),"kernel_io_entered_ns":at(38),"kernel_io_entered":True,
                    "receiver_polled_pending":True,"original_exit_confirmed":True,"observer":observer(39,40),
                    "heartbeat":heartbeat(3,41,42),"coverage":{"allocated":[2,4096,1],"accounting":active,
                        "original_lease_active":True,"io_release_withheld":True}},
                {"io_released_ns":at(45),"batch_joined_ns":at(50),"selected":1,"completed":1,"uncertain":0,
                    "not_started":0,"status_error":False,"is_complete":True,"original_exit_confirmed":True,
                    "original_lease_released":True,"published_status":empty,"regular_file":True,"allocated":[0,0,0]},
                {"old_batch_joined":True,"recovery_batch_joined":True,"tracker_joined":True,"accounting_joined":True,
                    "heartbeat_joined":True,"provider_joined":True,"peer_joined":True,"remaining_activation_owners":0,
                    "remaining_finalizing_owners":0,"allocated":[0,0,0],"accounting":zero|{"closed":True}},
            )
            for phase, value, offset in zip(aba.PHASES, values, (3,12,17,28,34,44,52,57)):
                self.witnesses.append({"version":1,"case":case,"phase":phase,"monotonic_ns":at(offset),
                    "unix_ns":at(offset)+1000,"sandbox_id":old,"backing_generation":backing,"evidence":copy.deepcopy(value)})

    def event(self, phase):
        return next(e for e in self.witnesses if e["phase"] == phase)

    def write(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(s) for s in self.samples))
        (self.root/"stdout.log").write_text("\n".join([report.PREFIX+json.dumps(e) for e in self.events]
            + [aba.PREFIX+json.dumps(e) for e in self.witnesses]))

    def validate(self):
        self.write()
        return aba.validate(self.root)

    def refused(self, changes):
        original = copy.deepcopy(self.witnesses)
        for index, change in enumerate(changes):
            with self.subTest(change=index):
                self.witnesses = copy.deepcopy(original)
                change()
                with self.assertRaises(ValueError): self.validate()

    def test_both_cases_preserve_explicit_native_measurement_limits(self):
        value = self.validate()
        self.assertEqual(set(value["cases"]), aba.CASES)
        self.assertTrue(value["native_batch_aba_complete"])
        for key in ("memory_envelope_calibrated","production_protection_proven","bootstrap_provenance_verified"):
            self.assertIs(value[key], False)

    def test_real_file_cli_accepts_complete_proof_and_refuses_missing_phase(self):
        self.write()
        command = [sys.executable, str(pathlib.Path(__file__).with_name("batch_aba_report.py")), str(self.root)]
        self.assertEqual(subprocess.run(command, capture_output=True).returncode, 0)
        self.witnesses.pop(); self.write()
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_missing_duplicate_replayed_and_reordered_phases_are_refused(self):
        self.refused((lambda:self.witnesses.pop(0),lambda:self.witnesses.insert(1,copy.deepcopy(self.witnesses[0])),
            lambda:self.witnesses[1].update(sandbox_id=str(uuid.uuid4())),
            lambda:self.event("batch_refused").update(monotonic_ns=self.event("recovery_tail_progress")["monotonic_ns"])))

    def test_unaccepted_full_original_custody_is_required(self):
        self.refused((lambda:self.event("admission_blocked")["evidence"]["accounting"].update(queued=1),
            lambda:self.event("pool_wait_progress")["evidence"]["accounting"].update(started=1),
            lambda:self.event("admission_wait_progress")["evidence"]["accounting"].update(cleanup_growth_bytes=1),
            lambda:self.event("admission_blocked")["evidence"].update(allocated=[0,0,0]),
            lambda:self.event("status_wait_progress")["evidence"].update(original_full_lease_active=False)))

    def test_changed_insertion_and_unchanged_physical_owner_are_required(self):
        self.refused((lambda:self.event("pool_wait_progress")["evidence"].update(revision=1),
            lambda:self.event("pool_wait_progress")["evidence"].update(same_insertion=True),
            lambda:self.event("pool_wait_progress")["evidence"].update(original_sandbox_id=str(uuid.uuid4())),
            lambda:self.event("pool_wait_progress")["evidence"].update(original_backing_generation=str(uuid.uuid4()))))

    def test_actual_resumed_reads_contention_and_acknowledgements_are_required(self):
        self.refused((lambda:self.event("status_wait_progress")["evidence"]["samples"].pop(),
            lambda:self.event("status_wait_progress")["evidence"]["samples"][0].update(age_ns=2_000_000_000),
            lambda:self.event("status_wait_progress")["evidence"]["samples"][0].update(started_ns=1),
            lambda:self.event("pool_wait_progress")["evidence"].update(heartbeat_polled_pending=False),
            lambda:self.event("admission_wait_progress")["evidence"]["heartbeat"]["receipt"].update(acknowledgement_status=500),
            lambda:self.event("status_wait_progress")["evidence"].update(status_waits_after=0),
            lambda:self.event("status_wait_progress")["evidence"]["accounting"].update(closed=True)))

    def test_old_report_requires_exact_original_refusal_and_current_live_status(self):
        self.refused((lambda:self.event("batch_refused")["evidence"].update(completed=1,is_complete=True),
            lambda:self.event("batch_refused")["evidence"].update(refusal_error="UnknownObservation"),
            lambda:self.event("batch_refused")["evidence"].update(refusal_sandbox_id=str(uuid.uuid4())),
            lambda:self.event("batch_refused")["evidence"].update(revision=4),
            lambda:self.event("batch_refused")["evidence"]["published_status"].pop("idle_sandboxes"),
            lambda:self.event("batch_refused")["evidence"].update(original_exit_polled_pending=False)))

    def test_separate_recovery_retains_io_custody_and_joins_every_owner(self):
        self.refused((lambda:self.event("recovery_tail_progress")["evidence"].update(recovery_started_ns=1),
            lambda:self.event("recovery_tail_progress")["evidence"]["coverage"].update(original_lease_active=False),
            lambda:self.event("recovery_completed")["evidence"].update(selected=0),
            lambda:self.event("recovery_completed")["evidence"].update(original_exit_confirmed=False),
            lambda:self.event("recovery_completed")["evidence"].update(io_released_ns=1),
            lambda:self.event("producers_joined")["evidence"].update(remaining_finalizing_owners=1)))

    def test_complete_original_home_and_raw_policy_identity_remain_required(self):
        self.events[-1]["evidence"]["original_home_restored"] = False
        with self.assertRaises(ValueError): self.validate()
        self.events[-1]["evidence"]["original_home_restored"] = True
        self.collector["metadata"]["native_batch_aba_policy_json"] += " "
        with self.assertRaises(ValueError): self.validate()


if __name__ == "__main__":
    unittest.main()
