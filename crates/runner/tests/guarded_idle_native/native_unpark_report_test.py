#!/usr/bin/env python3
"""Synthetic original-file and CLI checks; these do not execute native Guests."""

import copy
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

import native_unpark_report as native
import report
import report_test
import held_status_report_fixture as fixture


class NativeUnparkReportTests(unittest.TestCase):
    def setUp(self):
        fixture.prepare_native_unpark(self)

    def event(self, phase):
        return report_test.witness_for_phase(self.witnesses, phase)

    def validate(self):
        report_test.write_report_fixture(self.root, self.collector, self.samples,
            [(report.PREFIX, self.events), (native.PREFIX, self.witnesses)])
        return native.validate(self.root)

    def refused(self, changes):
        fixture.assert_unpark_witness_refusals(self, changes)

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
