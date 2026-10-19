#!/usr/bin/env python3
"""Synthetic original-file/CLI consumer checks, not native execution evidence."""

import copy
import hashlib
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

import cleanup_report as cleanup
import report
import speculative_fault_report as fault
import status_failure_report_test as failure_test


class SpeculativeFaultReportTests(unittest.TestCase):
    def setUp(self):
        failure_test.StatusFailureReportTests.setUp(self)
        raw = self.collector["metadata"].pop("native_status_failure_policy_json")
        self.collector["metadata"]["native_speculative_fault_policy_json"] = raw
        original, sample = self.events[:6], self.samples[0]
        self.events, self.samples, self.witnesses = [], [], []
        for index, case in enumerate(sorted(fault.CASES)):
            at = lambda offset: 10_000_000_000*(index+1)+offset*1_000_000
            old, backing, history, operation, runner = [str(uuid.uuid4()) for _ in range(5)]
            terminal = copy.deepcopy(original)
            for event, offset in zip(terminal, (0,1,40,41,70,100)):
                event.update(case=case, sandbox_id=old, backing_generation=backing,
                             monotonic_ns=at(offset), unix_ns=at(offset)+1000)
                reading = copy.deepcopy(sample)
                reading["monotonic_ns"] = at(offset)+1
                reading["processes"][0]["observed_monotonic_ns"] = at(offset)+1
                self.samples.append(reading)
            self.events.extend(terminal)
            mode = "panic" if case.startswith("SpeculativePanic-") else "drop"
            reuse = "thread:native-guarded-"+history
            initial = {"mode":"starting", "max_concurrent":1, "active_runs":[],
                "started_at":"2026-10-19T01:00:00Z", "updated_at":"2026-10-19T01:00:01Z",
                "idle_sandboxes":[{"reuse_key":reuse, "sandbox_id":old}]}
            empty = {k:v for k,v in initial.items() if k != "idle_sandboxes"}
            empty["updated_at"] = "2026-10-19T01:00:02Z"
            def heartbeat(sequence, begin, end, allocated):
                return {"receipt":{"received_ns":at(begin), "acknowledgement_status":204,
                    "state":{"runnerId":runner, "snapshotGeneration":1, "snapshotSequence":sequence,
                        "group":"native-foreground", "mode":"running", "allocatedVcpu":allocated[0],
                        "allocatedMemoryMb":allocated[1]}}, "send_joined":True, "completed_ns":at(end)}
            zero = dict.fromkeys(cleanup.COUNTS,0) | {"closed":True}
            active = zero | {"registered_operations":1, "started":1, "tracked_tasks":1,
                "cleanup_growth_bytes":self.policy["tail_growth_bytes"], "closed":False}
            coverage = {"allocated":[2,4096,1], "accounting":active,
                        "original_lease_active":True, "io_release_withheld":True}
            raw = history.encode()
            digest = hashlib.sha256((raw*(65536//len(raw)+1))[:65536]).hexdigest()
            values = (
                {"policy":self.policy, "status_path":str(self.root/f"case-{index}"/"status.json"),
                 "published_status":initial, "regular_file":True},
                {"mode":mode, "history_run_id":history, "operation_run_id":operation, "reuse_key":reuse,
                 "prepare_started_ns":at(5), "rpc_completed_ns":at(10), "payload_sha256":digest,
                 "payload_bytes":65536, "production_restore_completed":True, "private_marker_verified":True,
                 "ordinary_home_verified":True, "callback_polled_pending":True, "callback_release_withheld":True,
                 "pool_empty":True, "original_full_lease_active":True, "original_exit_polled_pending":True,
                 "allocated":[2,4096,1]},
                {"failure_requested_ns":at(14), "failure_joined_ns":at(16), "mode":mode,
                 "panic_caught":mode == "panic", "state":"Uncertain", "commit_refused":True,
                 "repark_refused":True, "incoming_refused":True, "original_metadata_preserved":True,
                 "original_full_lease_active":True, "original_exit_polled_pending":True,
                 "pool_empty":True, "allocated":[2,4096,1]},
                {"original_exit_confirmed":True, "receiver_polled_pending":True, "coverage":coverage},
                {"pool_held_ns":at(46), "status_held_ns":at(47), "heartbeat_pending_ns":at(48),
                 "heartbeat_polled_pending":True, "observer":{"started_ns":at(49), "completed_ns":at(50),
                    "available_bytes":32*1024**3, "age_ns":2, "read_duration_ns":1, "joined":True},
                 "coverage":coverage},
                {"pool_released_ns":at(56), "status_held_ns":at(47), "heartbeat":heartbeat(1,57,58,(2,4096)),
                 "receiver_polled_pending":True, "coverage":coverage},
                {"io_released_ns":at(66), "saving_joined_ns":at(72), "home_cache_promoted":True,
                 "original_lease_released":True, "allocated":[0,0,0], "accounting":zero},
                {"status_wait_polled_ns":at(76), "status_waits_before":0, "status_waits_after":1,
                 "heartbeat":heartbeat(2,78,79,(0,0)), "publication_polled_pending":True, "allocated":[0,0,0]},
                {"status_released_ns":at(86), "publication_joined_ns":at(87), "published_status":empty,
                 "regular_file":True, "allocated":[0,0,0]},
                {"tracker_joined":True, "accounting_joined":True, "heartbeat_joined":True,
                 "provider_joined":True, "peer_joined":True, "remaining_activation_owners":0,
                 "remaining_finalizing_owners":0, "allocated":[0,0,0], "accounting":zero},
            )
            for phase, value, offset in zip(fault.PHASES, values, (3,12,20,45,55,65,75,85,90,95)):
                self.witnesses.append({"version":1, "case":case, "phase":phase,
                    "monotonic_ns":at(offset), "unix_ns":at(offset)+1000, "sandbox_id":old,
                    "backing_generation":backing, "evidence":copy.deepcopy(value)})

    def event(self, phase):
        return next(e for e in self.witnesses if e["phase"] == phase)

    def write(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(sample) for sample in self.samples))
        (self.root/"stdout.log").write_text("\n".join([report.PREFIX+json.dumps(e) for e in self.events]
            + [fault.PREFIX+json.dumps(e) for e in self.witnesses]))

    def validate(self):
        self.write()
        return fault.validate(self.root)

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

    def test_all_modes_require_callback_loss_and_preserve_stronger_boundaries(self):
        value = self.validate()
        self.assertEqual(set(value["cases"]),fault.CASES)
        self.assertIs(value["native_speculative_callback_loss_complete"],True)
        for key in ("inflight_unpark_or_guest_rpc_cancellation_proven", "api_claim_arbitration_proven",
                    "full_supervisor_shutdown_proven", "memory_envelope_calibrated",
                    "production_protection_proven", "bootstrap_provenance_verified"):
            self.assertIs(value[key],False)

    def test_real_cli_reads_original_files_and_refuses_missing_phase(self):
        self.write()
        command = [sys.executable,str(pathlib.Path(__file__).with_name("speculative_fault_report.py")),str(self.root)]
        self.assertEqual(subprocess.run(command,capture_output=True).returncode,0)
        self.witnesses.pop(0); self.write()
        self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)

    def test_phase_identity_and_generation_replay_are_refused(self):
        self.refused((lambda:self.witnesses.pop(),lambda:self.witnesses.insert(1,copy.deepcopy(self.witnesses[0])),
            lambda:self.event("callback_waiting").update(sandbox_id=str(uuid.uuid4())),
            lambda:self.event("callback_waiting")["evidence"].update(history_run_id=str(uuid.uuid4())),
            lambda:self.event("callback_waiting")["evidence"].update(operation_run_id=self.event("callback_waiting")["evidence"]["history_run_id"]),
            lambda:self.event("inputs_verified")["evidence"].update(status_path="../status.json")))

    def test_actual_rpc_complete_bytes_and_pending_boundary_are_required(self):
        self.refused((lambda:self.event("callback_waiting")["evidence"].update(payload_sha256="0"*64),
            lambda:self.event("callback_waiting")["evidence"].update(payload_bytes=1),
            lambda:self.event("callback_waiting")["evidence"].update(production_restore_completed=False),
            lambda:self.event("callback_waiting")["evidence"].update(private_marker_verified=False),
            lambda:self.event("callback_waiting")["evidence"].update(callback_polled_pending=False),
            lambda:self.event("callback_waiting")["evidence"].update(callback_release_withheld=False)))

    def test_uncertain_state_and_all_refused_transfers_are_required(self):
        self.refused((lambda:self.event("preparation_lost")["evidence"].update(state="Prepared"),
            lambda:self.event("preparation_lost")["evidence"].update(panic_caught=True),
            lambda:self.event("preparation_lost")["evidence"].update(mode="panic"),
            lambda:self.event("preparation_lost")["evidence"].update(commit_refused=False),
            lambda:self.event("preparation_lost")["evidence"].update(repark_refused=False),
            lambda:self.event("preparation_lost")["evidence"].update(incoming_refused=False)))

    def test_full_original_lease_growth_exit_and_joined_saving_are_required(self):
        self.refused((lambda:self.event("callback_waiting")["evidence"].update(allocated=[0,0,0]),
            lambda:self.event("tail_blocked")["evidence"].update(original_exit_confirmed=False),
            lambda:self.event("tail_blocked")["evidence"]["coverage"]["accounting"].update(cleanup_growth_bytes=0),
            lambda:self.event("saving_joined")["evidence"].update(home_cache_promoted=False),
            lambda:self.event("saving_joined")["evidence"].update(original_lease_released=False),
            lambda:self.event("producers_joined")["evidence"].update(remaining_activation_owners=1)))

    def test_real_order_contention_and_acknowledged_progress_are_required(self):
        self.refused((lambda:self.event("callback_waiting")["evidence"].update(rpc_completed_ns=1),
            lambda:self.event("preparation_lost")["evidence"].update(failure_joined_ns=1),
            lambda:self.event("pool_wait_progress")["evidence"]["observer"].update(joined=False),
            lambda:self.event("tail_wait_progress")["evidence"]["heartbeat"]["receipt"].update(acknowledgement_status=500),
            lambda:self.event("status_wait_progress")["evidence"].update(status_waits_after=0),
            lambda:self.event("status_wait_progress")["evidence"]["heartbeat"]["receipt"]["state"].update(runnerId=str(uuid.uuid4()))))

    def test_current_empty_status_and_all_dependency_joins_are_required(self):
        self.refused((lambda:self.event("status_published")["evidence"].update(published_status=self.event("inputs_verified")["evidence"]["published_status"]),
            lambda:self.event("status_published")["evidence"].update(regular_file=False),
            lambda:self.event("producers_joined")["evidence"].update(peer_joined=False),
            lambda:self.event("producers_joined")["evidence"]["accounting"].update(tracked_tasks=1)))

    def test_original_data_source_policy_and_snapshot_binding_are_required(self):
        self.events[-1]["evidence"]["original_home_restored"] = False
        with self.assertRaises(ValueError): self.validate()
        self.events[-1]["evidence"]["original_home_restored"] = True
        raw = self.collector["metadata"]["native_speculative_fault_policy_json"]
        self.collector["metadata"]["native_speculative_fault_policy_json"] += " "
        with self.assertRaises(ValueError): self.validate()
        self.collector["metadata"]["native_speculative_fault_policy_json"] = raw
        self.artifacts["source_sha"] = "0"*40
        with self.assertRaises(ValueError): self.validate()
        self.artifacts["source_sha"] = "a"*40
        self.artifacts["snapshot_preparation_sha256"] = "0"*64
        with self.assertRaises(ValueError): self.validate()


if __name__ == "__main__":
    unittest.main()
