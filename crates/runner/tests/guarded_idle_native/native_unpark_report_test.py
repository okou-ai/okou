#!/usr/bin/env python3
"""Synthetic original-file and CLI checks; these do not execute native Guests."""

import copy
import hashlib
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

import native_unpark_report as native
import report
import speculative_fault_report_test as callback


class NativeUnparkReportTests(unittest.TestCase):
    def setUp(self):
        callback.SpeculativeFaultReportTests.setUp(self)
        self.collector["metadata"]["native_unpark_policy_json"] = self.collector["metadata"].pop("native_speculative_fault_policy_json")
        original, template, sample = copy.deepcopy(self.events[:6]), copy.deepcopy(self.witnesses[:10]), self.samples[0]
        old_base = template[0]["monotonic_ns"]-3_000_000
        old, backing = original[1]["sandbox_id"], original[1]["backing_generation"]
        old_history = template[1]["evidence"]["history_run_id"]
        old_runner = template[5]["evidence"]["heartbeat"]["receipt"]["state"]["runnerId"]
        self.events, self.samples, self.witnesses = [], [], []
        for index, case in enumerate(sorted(native.CASES)):
            at = lambda offset: 10_000_000_000*(index+1)+offset*1_000_000
            owner, generation, history, operation, runner = [str(uuid.uuid4()) for _ in range(5)]
            tokens = {old:owner,backing:generation,old_history:history,old_runner:runner,template[0]["case"]:case}
            def remap(value):
                if isinstance(value, dict): return {key:remap(item) for key,item in value.items()}
                if isinstance(value, list): return [remap(item) for item in value]
                if isinstance(value, str):
                    for before,after in tokens.items(): value = value.replace(before,after)
                    return value
                if type(value) is int and old_base <= value < old_base+1_000_000_000:
                    return at(0)+value-old_base
                return value
            terminal = remap(copy.deepcopy(original))
            for event, offset in zip(terminal,(0,1,40,41,70,100)):
                event.update(case=case,sandbox_id=owner,backing_generation=generation,
                             monotonic_ns=at(offset),unix_ns=at(offset)+1000)
                reading = copy.deepcopy(sample)
                reading["monotonic_ns"] = at(offset)+1
                reading["processes"][0]["observed_monotonic_ns"] = at(offset)+1
                self.samples.append(reading)
            self.events.extend(terminal)
            initial = remap(copy.deepcopy(template[0]["evidence"]))
            initial["status_path"] = str(self.root/f"case-{index}"/"status.json")
            raw = 'PATCH /vm HTTP/1.1\r\nContent-Length: 19\r\n\r\n{"state":"Resumed"}'
            response = "HTTP/1.1 204 No Content\r\n\r\n"
            request_sha, response_sha = [hashlib.sha256(value.encode()).hexdigest() for value in (raw,response)]
            mode = case.rsplit("-",1)[0]
            values = (
                initial,
                {"mode":mode,"history_run_id":history,"operation_run_id":operation,
                 "reuse_key":"thread:native-guarded-"+history,"prepare_started_ns":at(5),
                 "capture_observed_ns":at(7),"request_raw":raw,"request_sha256":request_sha,
                 "backend_socket":"/run/vm0/sock/"+owner+"/api.sock",
                 "front_socket":"/run/vm0/sock/"+owner+"/unpark-proof.sock",
                 "backend_dispatched":False,"restore_callback_reached":False,
                 "original_full_lease_active":True,"allocated":[2,4096,1]},
                {"backend_response_observed_ns":at(10),"backend_status":204,"response_raw":response,
                 "response_sha256":response_sha,"public_unpark_polled_pending":True,
                 "response_delivery_withheld":True,"restore_callback_reached":False,
                 "internal_vmm_inflight_claimed":False,"original_full_lease_active":True,
                 "original_exit_polled_pending":True,"allocated":[2,4096,1]},
                {"cancel_requested_ns":at(14),"observation_dropped_ns":at(16),
                 "observer_unwound":mode=="UnparkObserverUnwind","state":"Uncertain",
                 "commit_refused":True,"repark_refused":True,"incoming_refused":True,
                 "original_metadata_preserved":True,"original_full_lease_active":True,
                 "original_exit_polled_pending":True,"pool_empty":True,"allocated":[2,4096,1]},
                {"pool_held_ns":at(23),"heartbeat_pending_ns":at(24),"pool_released_ns":at(27),
                 "observer":{"started_ns":at(25),"completed_ns":at(26),"available_bytes":32*1024**3,
                     "age_ns":2,"read_duration_ns":1,"joined":True},
                 "heartbeat":{"receipt":{"received_ns":at(28),"acknowledgement_status":204,
                     "state":{"runnerId":runner,"snapshotGeneration":1,"snapshotSequence":1,
                         "group":"native-foreground","mode":"running","allocatedVcpu":2,"allocatedMemoryMb":4096}},
                     "send_joined":True,"completed_ns":at(29)},
                 "terminal_unpark_polled_pending":True,"response_delivery_withheld":True,
                 "additional_full_profile_refused":True,"original_full_lease_active":True,"allocated":[2,4096,1]},
                {"response_released_ns":at(36),"producer_joined_ns":at(38),"producer_joined":True,
                 "producer_unwound":mode=="UnparkProducerUnwind","backend_status":204,
                 "joined_request_sha256":None if mode=="UnparkProducerUnwind" else request_sha,
                 "accepted_response_before_cancellation":True,"internal_vmm_inflight_claimed":False},
            )
            for phase,value,offset in zip(native.PHASES,values,(3,8,12,20,35,39)):
                self.witnesses.append({"version":1,"case":case,"phase":phase,"monotonic_ns":at(offset),
                    "unix_ns":at(offset)+1000,"sandbox_id":owner,"backing_generation":generation,"evidence":value})
            saved = remap(copy.deepcopy(template[3:]))
            for event in saved:
                heartbeat = event["evidence"].get("heartbeat")
                if heartbeat: heartbeat["receipt"]["state"]["snapshotSequence"] += 1
            self.witnesses.extend(saved)

    def event(self, phase):
        return next(event for event in self.witnesses if event["phase"]==phase)

    def validate(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(item) for item in self.samples))
        (self.root/"stdout.log").write_text("\n".join([report.PREFIX+json.dumps(item) for item in self.events]
            +[native.PREFIX+json.dumps(item) for item in self.witnesses]))
        return native.validate(self.root)

    def refused(self, changes):
        original = copy.deepcopy(self.witnesses)
        for index,change in enumerate(changes):
            with self.subTest(change=index):
                self.witnesses = copy.deepcopy(original)
                change()
                with self.assertRaises(ValueError): self.validate()
        self.witnesses = original
        self.validate()

    def test_complete_api_wait_proof_keeps_stronger_boundaries_unclaimed(self):
        result = self.validate()
        self.assertEqual(set(result["cases"]),native.CASES)
        self.assertTrue(result["native_unpark_api_wait_cancellation_complete"])
        self.assertFalse(result["internal_vmm_execution_inflight_proven"])
        self.assertFalse(result["inflight_guest_rpc_cancellation_proven"])
        self.assertFalse(result["physical_pause_cancellation_proven"])

    def test_capture_callback_wrong_status_bytes_and_socket_are_not_acceptance(self):
        self.refused((lambda:self.witnesses.remove(self.event("resume_accepted_waiting")),
            lambda:self.event("resume_captured")["evidence"].update(backend_dispatched=True),
            lambda:self.event("resume_captured")["evidence"].update(backend_socket="/run/vm0/sock/other/api.sock"),
            lambda:self.event("resume_captured")["evidence"].update(request_sha256="0"*64),
            lambda:self.event("resume_captured")["evidence"].update(request_raw="PATCH /vm HTTP/1.1\r\n\r\n"),
            lambda:self.event("resume_accepted_waiting")["evidence"].update(backend_status=400),
            lambda:self.event("resume_accepted_waiting")["evidence"].update(response_sha256="0"*64),
            lambda:self.event("resume_accepted_waiting")["evidence"].update(restore_callback_reached=True),
            lambda:self.event("resume_accepted_waiting")["evidence"].update(public_unpark_polled_pending=False),
            lambda:self.event("resume_accepted_waiting")["evidence"].update(internal_vmm_inflight_claimed=True)))

    def test_original_owner_full_lease_history_and_uncertainty_are_required(self):
        self.refused((lambda:self.event("preparation_lost")["evidence"].update(state="Prepared"),
            lambda:self.event("preparation_lost")["evidence"].update(commit_refused=False),
            lambda:self.event("preparation_lost")["evidence"].update(incoming_refused=False),
            lambda:self.event("preparation_lost")["evidence"].update(original_metadata_preserved=False),
            lambda:self.event("preparation_lost")["evidence"].update(allocated=[0,0,0]),
            lambda:self.event("resume_captured")["evidence"].update(history_run_id=self.event("resume_captured")["sandbox_id"]),
            lambda:self.event("resume_accepted_waiting").update(backing_generation=str(uuid.uuid4()))))

    def test_independent_progress_no_headroom_and_actual_producer_join_are_required(self):
        self.refused((lambda:self.event("native_wait_progress")["evidence"].update(additional_full_profile_refused=False),
            lambda:self.event("native_wait_progress")["evidence"]["heartbeat"]["receipt"].update(acknowledgement_status=500),
            lambda:self.event("native_wait_progress")["evidence"]["observer"].update(joined=False),
            lambda:self.event("request_producer_joined")["evidence"].update(producer_joined=False),
            lambda:self.event("request_producer_joined")["evidence"].update(producer_unwound=True),
            lambda:self.event("request_producer_joined")["evidence"].update(joined_request_sha256=None),
            lambda:self.event("producers_joined")["evidence"].update(remaining_activation_owners=1)))

    def test_phase_identity_clocks_and_complete_saving_are_strict(self):
        self.refused((lambda:self.witnesses.append(copy.deepcopy(self.witnesses[0])),
            lambda:self.event("preparation_lost").update(monotonic_ns=1),
            lambda:self.event("request_producer_joined").update(unix_ns=1),
            lambda:self.event("tail_blocked")["evidence"].update(original_exit_confirmed=False),
            lambda:self.event("saving_joined")["evidence"].update(home_cache_promoted=False),
            lambda:self.event("saving_joined")["evidence"].update(original_lease_released=False)))

    def test_p1_intervention_never_becomes_native_success(self):
        self.validate()
        self.collector["cleanup_intervened"] = True
        with self.assertRaises(ValueError): self.validate()

    def test_cli_accepts_original_complete_files_and_rejects_missing_acceptance(self):
        self.validate()
        command = [sys.executable,str(pathlib.Path(native.__file__)),str(self.root)]
        good = subprocess.run(command,capture_output=True,text=True)
        self.assertEqual(good.returncode,0,good.stderr)
        self.assertTrue(json.loads(good.stdout)["native_unpark_api_wait_cancellation_complete"])
        self.witnesses.remove(self.event("resume_accepted_waiting"))
        with self.assertRaises(ValueError): self.validate()
        self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)


if __name__ == "__main__":
    unittest.main()
