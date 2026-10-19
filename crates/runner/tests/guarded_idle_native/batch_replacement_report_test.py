#!/usr/bin/env python3
"""Synthetic original-file/CLI regressions, never a substitute for native proof."""

import copy
import hashlib
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

import batch_replacement_report as replacement
import cleanup_report as cleanup
import report
import status_failure_report_test as failure_test


class ReplacementReportTests(unittest.TestCase):
    def setUp(self):
        failure_test.StatusFailureReportTests.setUp(self)
        raw = json.dumps(self.policy)
        self.collector["metadata"].pop("native_status_failure_policy_json")
        self.collector["metadata"]["native_batch_replacement_policy_json"] = raw
        self.artifacts["policy_sha256"] = hashlib.sha256(raw.encode()).hexdigest()
        original, sample = self.events[:6], self.samples[0]
        self.events, self.samples, self.witnesses = [], [], []
        for index, case in enumerate(sorted(replacement.CASES)):
            at = lambda offset: 10_000_000_000*(index+1) + offset*1_000_000
            old, backing, new, new_backing, operation, runner = [str(uuid.uuid4()) for _ in range(6)]
            terminal = copy.deepcopy(original)
            for event, offset in zip(terminal,(0,1,9,10,26,65)):
                event.update(case=case,sandbox_id=old,backing_generation=backing,
                             monotonic_ns=at(offset),unix_ns=at(offset)+1000)
                reading = copy.deepcopy(sample)
                reading["monotonic_ns"] = at(offset)+1
                reading["processes"][0]["observed_monotonic_ns"] = at(offset)+1
                self.samples.append(reading)
            self.events.extend(terminal)
            zero = dict.fromkeys(cleanup.COUNTS,0) | {"closed":False}
            active = zero | {"registered_operations":3,"queued":2,"started":1,"tracked_tasks":1,
                             "cleanup_growth_bytes":self.policy["tail_growth_bytes"]}
            coverage = {"allocated":[4,8192,2],"accounting":active,
                        "original_lease_active":True,"io_release_withheld":True}
            reuse = "thread:native-guarded-"+str(uuid.uuid4())
            initial = {"mode":"starting","max_concurrent":1,"active_runs":[],
                "started_at":"2026-10-19T01:00:00Z","updated_at":"2026-10-19T01:00:01Z",
                "idle_sandboxes":[{"reuse_key":reuse,"sandbox_id":old}]}
            current = copy.deepcopy(initial)
            current.update(updated_at="2026-10-19T01:00:02Z",
                           idle_sandboxes=[{"reuse_key":reuse,"sandbox_id":new}])
            empty = {k:v for k,v in current.items() if k != "idle_sandboxes"}
            empty["updated_at"] = "2026-10-19T01:00:03Z"
            def heartbeat(sequence,begin,end,allocated):
                return {"receipt":{"received_ns":at(begin),"acknowledgement_status":204,
                    "state":{"runnerId":runner,"snapshotGeneration":1,"snapshotSequence":sequence,
                        "group":"native-foreground","mode":"running","allocatedVcpu":allocated[0],
                        "allocatedMemoryMb":allocated[1]}},"send_joined":True,"completed_ns":at(end)}
            reads = [{"started_ns":at(offset),"finished_ns":at(offset)+1000,
                "read_start_offset_ns":offset*1_000_000,"available_bytes":32*1024**3,
                "age_ns":2,"read_duration_ns":1} for offset in (7,8,33)]
            values = (
                {"policy":self.policy,"status_path":str(self.root/f"case-{index}"/"status.json"),
                 "published_status":initial,"selected_revision":1,
                 "preparation":{"sandbox_id":new,"backing_generation":new_backing,"operation_id":operation,
                    "grant_started_ns":at(2),"grant_finished_ns":at(3),"prepared_ns":at(4),
                    "guest_rpc_completed":True,"phase_settled":True,"separate_incoming_lease":True},
                 "same_reuse_key":reuse,"source_read_blocked":True,"receiver_polled_pending":True,
                 "accounting":zero|{"registered_operations":2,"queued":2},"allocated":[4,8192,2],
                 "original_full_lease_active":True,"original_exit_polled_pending":True,"incoming_exit_polled_pending":True},
                {"insertion_started_ns":at(6),"revision":2,"original_exit_confirmed":True,
                 "receiver_polled_pending":True,"coverage":coverage},
                {"pool_held_ns":at(13),"heartbeat_pending_ns":at(14),"heartbeat_polled_pending":True,
                 "observer":{"started_ns":at(15),"completed_ns":at(16),"available_bytes":32*1024**3,
                    "age_ns":2,"read_duration_ns":1,"joined":True},"coverage":coverage},
                {"pool_released_ns":at(19),"heartbeat":heartbeat(1,20,21,(4,8192)),
                 "receiver_polled_pending":True,"coverage":coverage},
                {"io_released_ns":at(24),"retirement_joined_ns":at(27),"home_cache_promoted":True,
                 "original_exit_confirmed":True,"original_lease_released":True,"incoming_exit_polled_pending":True,
                 "receiver_polled_pending":True,"allocated":[2,4096,1]},
                {"status_held_ns":at(31),"source_resumed_ns":at(32),"status_wait_polled_ns":at(34),
                 "status_waits_before":0,"status_waits_after":1,"heartbeat":heartbeat(2,35,36,(2,4096)),
                 "accounting":zero,"samples":reads,"receiver_polled_pending":True,"allocated":[2,4096,1]},
                {"status_released_ns":at(39),"batch_joined_ns":at(40),"selected":1,"completed":0,"uncertain":0,
                 "not_started":1,"status_error":False,"is_complete":False,"refused_sandbox_id":old,
                 "refused_reuse_key":reuse,"error":"AccountingChanged","revision":2,"published_status":current,
                 "regular_file":True,"incoming_exit_polled_pending":True,"allocated":[2,4096,1]},
                {"started_ns":at(43),"joined_ns":at(44),"selected":1,"completed":1,"uncertain":0,
                 "not_started":0,"status_error":False,"is_complete":True,"incoming_exit_confirmed":True,
                 "published_status":empty,"allocated":[0,0,0]},
                {"old_batch_joined":True,"replacement_joined":True,"incoming_batch_joined":True,
                 "tracker_joined":True,"accounting_joined":True,"heartbeat_joined":True,"provider_joined":True,"peer_joined":True,
                 "remaining_activation_owners":0,"remaining_finalizing_owners":0,
                 "allocated":[0,0,0],"accounting":zero|{"closed":True}},
            )
            for phase,value,offset in zip(replacement.PHASES,values,(5,12,18,23,29,38,42,46,50)):
                self.witnesses.append({"version":1,"case":case,"phase":phase,"monotonic_ns":at(offset),
                    "unix_ns":at(offset)+1000,"sandbox_id":old,"backing_generation":backing,"evidence":copy.deepcopy(value)})

    def event(self,phase):
        return next(e for e in self.witnesses if e["phase"] == phase)

    def write(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(s) for s in self.samples))
        (self.root/"stdout.log").write_text("\n".join([report.PREFIX+json.dumps(e) for e in self.events]
            + [replacement.PREFIX+json.dumps(e) for e in self.witnesses]))

    def validate(self):
        self.write()
        return replacement.validate(self.root)

    def refused(self,changes):
        original = copy.deepcopy(self.witnesses)
        for index,change in enumerate(changes):
            with self.subTest(change=index):
                self.witnesses = copy.deepcopy(original)
                change()
                with self.assertRaises(ValueError): self.validate()

    def test_both_cases_preserve_explicit_evidence_limits(self):
        result = self.validate()
        self.assertEqual(set(result["cases"]),replacement.CASES)
        self.assertTrue(result["native_batch_replacement_complete"])
        for key in ("memory_envelope_calibrated","production_protection_proven","bootstrap_provenance_verified",
                    "incoming_required_history_proven","actual_api_claim_loss_proven"):
            self.assertIs(result[key],False)

    def test_real_cli_reads_original_files_and_refuses_missing_phase(self):
        self.write()
        command = [sys.executable,str(pathlib.Path(__file__).with_name("batch_replacement_report.py")),str(self.root)]
        self.assertEqual(subprocess.run(command,capture_output=True).returncode,0)
        self.witnesses.pop(); self.write()
        self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)

    def test_phase_order_original_identity_and_incoming_replays_are_refused(self):
        self.refused((lambda:self.witnesses.pop(0),lambda:self.witnesses.insert(1,copy.deepcopy(self.witnesses[0])),
            lambda:self.witnesses[1].update(sandbox_id=str(uuid.uuid4())),
            lambda:self.event("admission_blocked")["evidence"]["preparation"].update(sandbox_id=self.witnesses[0]["sandbox_id"]),
            lambda:self.event("admission_blocked")["evidence"]["preparation"].update(guest_rpc_completed=False),
            lambda:self.event("admission_blocked")["evidence"].update(same_reuse_key="thread:other")))

    def test_original_saving_and_full_lease_custody_are_required(self):
        self.refused((lambda:self.event("tail_blocked")["evidence"]["coverage"].update(allocated=[2,4096,1]),
            lambda:self.event("pool_wait_progress")["evidence"]["coverage"]["accounting"].update(queued=0),
            lambda:self.event("tail_wait_progress")["evidence"]["coverage"]["accounting"].update(cleanup_growth_bytes=0),
            lambda:self.event("original_saved")["evidence"].update(home_cache_promoted=False),
            lambda:self.event("original_saved")["evidence"].update(original_lease_released=False),
            lambda:self.event("original_saved")["evidence"].update(incoming_exit_polled_pending=False)))

    def test_independent_progress_actual_reads_and_status_wait_are_required(self):
        self.refused((lambda:self.event("pool_wait_progress")["evidence"].update(heartbeat_polled_pending=False),
            lambda:self.event("pool_wait_progress")["evidence"]["observer"].update(joined=False),
            lambda:self.event("tail_wait_progress")["evidence"]["heartbeat"]["receipt"].update(acknowledgement_status=500),
            lambda:self.event("status_wait_progress")["evidence"].update(status_waits_after=0),
            lambda:self.event("status_wait_progress")["evidence"]["samples"].pop(),
            lambda:self.event("status_wait_progress")["evidence"]["samples"][-1].update(available_bytes=0)))

    def test_exact_old_accounting_refusal_and_distinct_current_inventory_are_required(self):
        self.refused((lambda:self.event("batch_refused")["evidence"].update(error="ResourceChanged"),
            lambda:self.event("batch_refused")["evidence"].update(completed=1),
            lambda:self.event("batch_refused")["evidence"].update(refused_sandbox_id=str(uuid.uuid4())),
            lambda:self.event("batch_refused")["evidence"].update(published_status=self.event("admission_blocked")["evidence"]["published_status"]),
            lambda:self.event("batch_refused")["evidence"].update(revision=3),
            lambda:self.event("incoming_retired")["evidence"].update(selected=0),
            lambda:self.event("producers_joined")["evidence"].update(remaining_activation_owners=1)))

    def test_complete_original_home_policy_source_and_snapshot_bindings_are_required(self):
        self.events[-1]["evidence"]["original_home_restored"] = False
        with self.assertRaises(ValueError): self.validate()
        self.events[-1]["evidence"]["original_home_restored"] = True
        raw = self.collector["metadata"]["native_batch_replacement_policy_json"]
        self.collector["metadata"]["native_batch_replacement_policy_json"] += " "
        with self.assertRaises(ValueError): self.validate()
        self.collector["metadata"]["native_batch_replacement_policy_json"] = raw
        self.artifacts["source_sha"] = "0"*40
        with self.assertRaises(ValueError): self.validate()


if __name__ == "__main__":
    unittest.main()
