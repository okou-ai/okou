#!/usr/bin/env python3
"""Synthetic original pause-file and real CLI checks, not native Guest evidence."""

import copy
import hashlib
import json
import pathlib
import subprocess
import sys
import unittest

import native_pause_report as native
import native_unpark_report_test as unpark
import report


class NativePauseReportTests(unittest.TestCase):
    event = unpark.NativeUnparkReportTests.event
    refused = unpark.NativeUnparkReportTests.refused

    def setUp(self):
        unpark.NativeUnparkReportTests.setUp(self)
        self.collector["metadata"]["native_pause_policy_json"] = self.collector["metadata"].pop("native_unpark_policy_json")
        self.events = json.loads(json.dumps(self.events).replace("Unpark", "Pause"))
        source = json.loads(json.dumps(self.witnesses).replace("Unpark", "Pause"))
        self.witnesses = []
        for event in source:
            value = event["evidence"]
            if event["phase"] == "resume_captured":
                event["phase"] = "pause_captured"
                raw = 'PATCH /vm HTTP/1.1\r\nContent-Length: 18\r\n\r\n{"state":"Paused"}'
                history = value["history_run_id"].encode()
                value.update(request_raw=raw, request_sha256=hashlib.sha256(raw.encode()).hexdigest(),
                    front_socket=value["front_socket"].replace("unpark-proof.sock", "pause-proof.sock"),
                    restore_callback_reached=True, data_verified_ns=value["prepare_started_ns"]+1,
                    repark_started_ns=value["prepare_started_ns"]+2, payload_bytes=65536,
                    payload_sha256=hashlib.sha256((history*(65536//len(history)+1))[:65536]).hexdigest(),
                    production_restore_completed=True, private_history_verified=True, ordinary_home_verified=True)
            elif event["phase"] == "resume_accepted_waiting":
                event["phase"] = "pause_accepted_waiting"
                value["public_park_polled_pending"] = value.pop("public_unpark_polled_pending")
                value["restore_callback_reached"] = True
            elif event["phase"] == "request_producer_joined":
                raw = 'PATCH /vm HTTP/1.1\r\nContent-Length: 18\r\n\r\n{"state":"Paused"}'
                if value["joined_request_sha256"] is not None:
                    value["joined_request_sha256"] = hashlib.sha256(raw.encode()).hexdigest()
            self.witnesses.append(event)
            if event["phase"] == "request_producer_joined":
                ready = copy.deepcopy(event)
                ready.update(phase="terminal_readiness_joined",
                    monotonic_ns=event["monotonic_ns"]+500000,
                    unix_ns=event["unix_ns"]+500000,
                    evidence={"pause_and_resume_readiness_joined":True, "ordinary_reuse_reopened":False,
                        "state":"Uncertain", "original_full_lease_active":True,
                        "original_exit_polled_pending":True, "allocated":[2,4096,1]})
                self.witnesses.append(ready)

    def validate(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(item) for item in self.samples))
        (self.root/"stdout.log").write_text("\n".join(
            [report.PREFIX+json.dumps(item) for item in self.events]
            +[native.PREFIX+json.dumps(item) for item in self.witnesses]))
        return native.validate(self.root)

    def test_complete_actual_pause_keeps_other_boundaries_unclaimed(self):
        result = self.validate()
        self.assertEqual(set(result["cases"]), native.CASES)
        self.assertTrue(result["native_physical_pause_cancellation_complete"])
        self.assertTrue(result["physical_pause_cancellation_proven"])
        self.assertFalse(result["internal_vmm_execution_inflight_proven"])
        self.assertFalse(result["inflight_guest_rpc_cancellation_proven"])
        self.assertFalse(result["full_supervisor_shutdown_proven"])

    def test_capture_resume_callback_or_bad_socket_cannot_substitute_for_pause(self):
        self.refused((
            lambda:self.witnesses.remove(self.event("pause_accepted_waiting")),
            lambda:self.event("pause_captured")["evidence"].update(request_raw='PATCH /vm HTTP/1.1\r\nContent-Length: 19\r\n\r\n{"state":"Resumed"}'),
            lambda:self.event("pause_captured")["evidence"].update(front_socket="/run/vm0/sock/foreign/pause-proof.sock"),
            lambda:self.event("pause_captured")["evidence"].update(backend_dispatched=True),
            lambda:self.event("pause_accepted_waiting")["evidence"].update(backend_status=400),
            lambda:self.event("pause_accepted_waiting")["evidence"].update(public_park_polled_pending=False),
            lambda:self.event("pause_accepted_waiting")["evidence"].update(internal_vmm_inflight_claimed=True)))

    def test_real_data_restore_history_and_repark_order_are_required(self):
        self.refused((
            lambda:self.event("pause_captured")["evidence"].update(production_restore_completed=False),
            lambda:self.event("pause_captured")["evidence"].update(private_history_verified=False),
            lambda:self.event("pause_captured")["evidence"].update(payload_sha256="0"*64),
            lambda:self.event("pause_captured")["evidence"].update(data_verified_ns=1),
            lambda:self.event("pause_captured")["evidence"].update(repark_started_ns=1),
            lambda:self.event("pause_captured")["evidence"].update(payload_bytes=1),
            lambda:self.event("pause_captured")["evidence"].update(restore_callback_reached=False)))

    def test_original_full_owner_uncertainty_and_producer_attribution_are_required(self):
        self.refused((
            lambda:self.event("preparation_lost")["evidence"].update(state="Reparked"),
            lambda:self.event("preparation_lost")["evidence"].update(incoming_refused=False),
            lambda:self.event("preparation_lost")["evidence"].update(allocated=[0,0,0]),
            lambda:self.event("request_producer_joined")["evidence"].update(producer_unwound=True),
            lambda:self.event("request_producer_joined")["evidence"].update(producer_joined=False),
            lambda:self.event("request_producer_joined")["evidence"].update(joined_request_sha256=None)))

    def test_positive_readiness_never_reopens_ordinary_reuse(self):
        self.refused((
            lambda:self.witnesses.remove(self.event("terminal_readiness_joined")),
            lambda:self.event("terminal_readiness_joined")["evidence"].update(pause_and_resume_readiness_joined=False),
            lambda:self.event("terminal_readiness_joined")["evidence"].update(ordinary_reuse_reopened=True),
            lambda:self.event("terminal_readiness_joined")["evidence"].update(state="Prepared"),
            lambda:self.event("terminal_readiness_joined").update(monotonic_ns=1)))

    def test_progress_complete_saving_and_all_joins_remain_required(self):
        self.refused((
            lambda:self.event("native_wait_progress")["evidence"].update(additional_full_profile_refused=False),
            lambda:self.event("native_wait_progress")["evidence"]["heartbeat"]["receipt"].update(acknowledgement_status=500),
            lambda:self.event("tail_blocked")["evidence"].update(original_exit_confirmed=False),
            lambda:self.event("saving_joined")["evidence"].update(home_cache_promoted=False),
            lambda:self.event("saving_joined")["evidence"].update(original_lease_released=False),
            lambda:self.event("producers_joined")["evidence"].update(remaining_activation_owners=1),
            lambda:self.witnesses.append(copy.deepcopy(self.witnesses[0]))))

    def test_p1_intervention_is_failure(self):
        self.validate()
        self.collector["cleanup_intervened"] = True
        with self.assertRaises(ValueError): self.validate()

    def test_cli_reads_original_complete_files_and_refuses_missing_acceptance(self):
        self.validate()
        command = [sys.executable, str(pathlib.Path(native.__file__)), str(self.root)]
        good = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(good.returncode, 0, good.stderr)
        self.assertTrue(json.loads(good.stdout)["native_physical_pause_cancellation_complete"])
        self.witnesses.remove(self.event("pause_accepted_waiting"))
        with self.assertRaises(ValueError): self.validate()
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)


if __name__ == "__main__":
    unittest.main()
