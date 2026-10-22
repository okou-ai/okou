#!/usr/bin/env python3
"""Synthetic original-file and CLI regressions, never native execution proof."""

import copy
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

import claim_loss_report as claim
import cleanup_report as cleanup
import report
import status_failure_report_test as failure_test


class ClaimLossReportTests(unittest.TestCase):
    def setUp(self):
        failure_test.StatusFailureReportTests.setUp(self)
        raw = self.collector["metadata"].pop("native_status_failure_policy_json")
        self.collector["metadata"]["native_claim_loss_policy_json"] = raw
        original, sample = self.events[:6], self.samples[0]
        self.events, self.samples, self.witnesses = [], [], []
        for index, case in enumerate(sorted(claim.CASES)):
            at = lambda offset: 10_000_000_000*(index+1)+offset*1_000_000
            old, backing, history, run, runner = [str(uuid.uuid4()) for _ in range(5)]
            terminal = copy.deepcopy(original)
            for event, offset in zip(terminal, (0,1,32,33,47,70)):
                event.update(case=case, sandbox_id=old, backing_generation=backing,
                             monotonic_ns=at(offset), unix_ns=at(offset)+1000)
                reading = copy.deepcopy(sample)
                reading["monotonic_ns"] = at(offset)+1
                reading["processes"][0]["observed_monotonic_ns"] = at(offset)+1
                self.samples.append(reading)
            self.events.extend(terminal)
            reuse = "thread:native-guarded-"+history
            initial = {"mode":"starting", "max_concurrent":1, "active_runs":[],
                "started_at":"2026-10-19T01:00:00Z", "updated_at":"2026-10-19T01:00:01Z",
                "idle_sandboxes":[{"reuse_key":reuse, "sandbox_id":old}]}
            restored = copy.deepcopy(initial)
            restored["updated_at"] = "2026-10-19T01:00:02Z"
            empty = {k:v for k,v in restored.items() if k != "idle_sandboxes"}
            empty["updated_at"] = "2026-10-19T01:00:03Z"
            held = [{"reuseKey":reuse, "lastCompletedAt":"2026-10-19T01:00:00Z",
                "reusableSandbox":{"profile":"vm0/default", "sourceRunId":history}}]
            def heartbeat(sequence, begin, end, allocated, states=None):
                return {"receipt":{"received_ns":at(begin), "acknowledgement_status":204,
                    "state":{"runnerId":runner, "snapshotGeneration":1, "snapshotSequence":sequence,
                        "group":"native-foreground", "mode":"running", "allocatedVcpu":allocated[0],
                        "allocatedMemoryMb":allocated[1], "heldSandboxStates":states or []}},
                    "send_joined":True, "completed_ns":at(end)}
            request = {"path":f"/api/runners/jobs/{run}/claim", "received_ns":at(6),
                "body":{"runnerIdentity":{"runnerId":runner, "heartbeatGeneration":1},
                    "capabilities":{"piModelConfigGenerations":[1,2,3]},
                    "telemetry":{"jobDiscoveredToClaimRequestMs":1}}}
            zero = dict.fromkeys(cleanup.COUNTS,0) | {"closed":False}
            active = zero | {"registered_operations":1, "started":1, "tracked_tasks":1,
                             "cleanup_growth_bytes":self.policy["tail_growth_bytes"]}
            coverage = {"allocated":[2,4096,1], "accounting":active,
                        "original_lease_active":True, "io_release_withheld":True}
            values = (
                {"policy":self.policy, "status_path":str(self.root/f"case-{index}"/"status.json"),
                 "published_status":initial, "selected_revision":1, "history_run_id":history,
                 "claim_run_id":run, "original_held_states":held, "request":request,
                 "claim_response_held":True, "preparation_polled_pending":True,
                 "original_full_lease_active":True, "original_exit_polled_pending":True,
                 "pool_empty":True, "allocated":[2,4096,1]},
                {"pool_held_ns":at(9), "heartbeat_pending_ns":at(10), "heartbeat_polled_pending":True,
                 "observer":{"started_ns":at(11), "completed_ns":at(12), "available_bytes":32*1024**3,
                    "age_ns":2, "read_duration_ns":1, "joined":True}, "claim_response_held":True,
                 "original_full_lease_active":True, "allocated":[2,4096,1]},
                {"pool_released_ns":at(15), "heartbeat":heartbeat(1,16,17,(2,4096)),
                 "claim_response_held":True, "preparation_polled_pending":True,
                 "original_full_lease_active":True, "allocated":[2,4096,1]},
                {"response_release_requested_ns":at(21), "preparation_joined_ns":at(24),
                 "receipt":request|{"response_released_ns":at(22), "status":404}, "claim_unavailable":True,
                 "commit_refused":True, "guest_preparation_completed":True, "pool_empty":True,
                 "original_full_lease_active":True, "original_exit_polled_pending":True, "allocated":[2,4096,1]},
                {"rollback_started_ns":at(27), "rollback_joined_ns":at(28), "revision":3,
                 "sandbox_id":old, "reuse_key":reuse, "history_run_id":history,
                 "guest_preparation_completed":True, "physical_repark_completed":True, "guarded_restore_completed":True,
                 "heartbeat":heartbeat(2,29,30,(2,4096),held), "published_status":restored, "regular_file":True,
                 "original_full_lease_active":True, "original_exit_polled_pending":True, "allocated":[2,4096,1]},
                {"original_exit_confirmed":True, "receiver_polled_pending":True, "coverage":coverage},
                {"observer":{"started_ns":at(37), "completed_ns":at(38), "available_bytes":32*1024**3,
                    "age_ns":2, "read_duration_ns":1, "joined":True}, "heartbeat":heartbeat(3,39,40,(2,4096)),
                 "receiver_polled_pending":True, "coverage":coverage},
                {"status_held_ns":at(43), "io_released_ns":at(44), "status_wait_polled_ns":at(49),
                 "status_waits_before":0, "status_waits_after":1, "heartbeat":heartbeat(4,50,51,(0,0)),
                 "original_lease_released":True, "receiver_polled_pending":True,
                 "accounting":zero, "allocated":[0,0,0]},
                {"status_released_ns":at(56), "batch_joined_ns":at(57), "selected":1, "completed":1,
                 "uncertain":0, "not_started":0, "status_error":False, "is_complete":True,
                 "published_status":empty, "regular_file":True, "allocated":[0,0,0]},
                {"claim_joined":True, "batch_joined":True, "tracker_joined":True, "accounting_joined":True,
                 "heartbeat_joined":True, "provider_joined":True, "peer_joined":True,
                 "remaining_activation_owners":0, "remaining_finalizing_owners":0,
                 "allocated":[0,0,0], "accounting":zero|{"closed":True}},
            )
            for phase, value, offset in zip(claim.PHASES, values, (8,14,20,26,31,36,42,55,61,65)):
                self.witnesses.append({"version":1, "case":case, "phase":phase,
                    "monotonic_ns":at(offset), "unix_ns":at(offset)+1000, "sandbox_id":old,
                    "backing_generation":backing, "evidence":copy.deepcopy(value)})

    def event(self, phase):
        return next(e for e in self.witnesses if e["phase"] == phase)

    def write(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(s) for s in self.samples))
        (self.root/"stdout.log").write_text("\n".join([report.PREFIX+json.dumps(e) for e in self.events]
            + [claim.PREFIX+json.dumps(e) for e in self.witnesses]))

    def validate(self):
        self.write()
        return claim.validate(self.root)

    def refused(self, changes):
        original = copy.deepcopy(self.witnesses)
        try:
            for index, change in enumerate(changes):
                with self.subTest(change=index):
                    self.witnesses = copy.deepcopy(original)
                    change()
                    with self.assertRaises(ValueError): self.validate()
        finally:
            self.witnesses = original
        self.validate()

    def test_both_modes_preserve_explicit_provider_and_measurement_boundaries(self):
        value = self.validate()
        self.assertEqual(set(value["cases"]), claim.CASES)
        self.assertTrue(value["api_claim_404_rejection_proven"])
        for key in ("actual_api_claim_loss_proven", "api_claim_arbitration_proven", "cancelled_guest_preparation_proven",
                    "memory_envelope_calibrated", "production_protection_proven", "bootstrap_provenance_verified"):
            self.assertIs(value[key], False)

    def test_real_cli_reads_original_files_and_refuses_missing_claim_phase(self):
        self.write()
        command = [sys.executable, str(pathlib.Path(__file__).with_name("claim_loss_report.py")), str(self.root)]
        self.assertEqual(subprocess.run(command,capture_output=True).returncode,0)
        self.witnesses.pop(0); self.write()
        self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)

    def test_phase_original_identity_and_replayed_claims_are_refused(self):
        self.refused((lambda:self.witnesses.pop(), lambda:self.witnesses.insert(1,copy.deepcopy(self.witnesses[0])),
            lambda:self.witnesses[1].update(sandbox_id=str(uuid.uuid4())),
            lambda:self.event("claim_waiting")["evidence"].update(claim_run_id=self.witnesses[0]["sandbox_id"]),
            lambda:self.event("claim_waiting")["evidence"].update(history_run_id=str(uuid.uuid4())),
            lambda:self.witnesses[0].update(monotonic_ns=1)))

    def test_real404_request_authority_and_absent_claim_are_required(self):
        self.refused((lambda:self.event("claim_waiting")["evidence"]["request"].update(path="/api/runners/jobs/other/claim"),
            lambda:self.event("claim_waiting")["evidence"]["request"]["body"]["runnerIdentity"].update(heartbeatGeneration=True),
            lambda:self.event("claim_rejected")["evidence"]["receipt"].update(status=200),
            lambda:self.event("claim_rejected")["evidence"].update(commit_refused=False),
            lambda:self.event("claim_rejected")["evidence"].update(claim_unavailable=False),
            lambda:self.event("claim_rejected")["evidence"].update(guest_preparation_completed=False)))

    def test_real_response_order_and_pending_progress_are_required(self):
        self.refused((lambda:self.event("claim_waiting")["evidence"]["request"].update(received_ns=1),
            lambda:self.event("claim_wait_progress")["evidence"].update(claim_response_held=False),
            lambda:self.event("pool_wait_progress")["evidence"]["observer"].update(joined=False),
            lambda:self.event("claim_rejected")["evidence"]["receipt"].update(response_released_ns=1),
            lambda:self.event("tail_wait_progress")["evidence"]["heartbeat"]["receipt"].update(acknowledgement_status=500),
            lambda:self.event("status_wait_progress")["evidence"].update(status_waits_after=0)))

    def test_full_lease_guarded_repark_and_advertised_original_history_are_required(self):
        self.refused((lambda:self.event("claim_waiting")["evidence"].update(allocated=[0,0,0]),
            lambda:self.event("original_restored")["evidence"].update(physical_repark_completed=False),
            lambda:self.event("original_restored")["evidence"].update(sandbox_id=str(uuid.uuid4())),
            lambda:self.event("original_restored")["evidence"].update(revision=1),
            lambda:self.event("original_restored")["evidence"]["heartbeat"]["receipt"]["state"]["heldSandboxStates"][0]["reusableSandbox"].update(sourceRunId=str(uuid.uuid4())),
            lambda:self.event("tail_blocked")["evidence"]["coverage"]["accounting"].update(cleanup_growth_bytes=0)))

    def test_positive_joined_original_saving_and_empty_current_status_are_required(self):
        self.refused((lambda:self.event("original_completed")["evidence"].update(completed=0),
            lambda:self.event("original_completed")["evidence"].update(published_status=self.event("original_restored")["evidence"]["published_status"]),
            lambda:self.event("status_wait_progress")["evidence"].update(original_lease_released=False),
            lambda:self.event("producers_joined")["evidence"].update(claim_joined=False),
            lambda:self.event("producers_joined")["evidence"].update(remaining_activation_owners=1)))

    def test_original_home_raw_policy_and_source_are_required(self):
        self.events[-1]["evidence"]["original_home_restored"] = False
        with self.assertRaises(ValueError): self.validate()
        self.events[-1]["evidence"]["original_home_restored"] = True
        raw = self.collector["metadata"]["native_claim_loss_policy_json"]
        self.collector["metadata"]["native_claim_loss_policy_json"] += " "
        with self.assertRaises(ValueError): self.validate()
        self.collector["metadata"]["native_claim_loss_policy_json"] = raw
        self.artifacts["source_sha"] = "0"*40
        with self.assertRaises(ValueError): self.validate()


if __name__ == "__main__":
    unittest.main()
