#!/usr/bin/env python3
"""Synthetic original-file/CLI regressions, never a substitute for native proof."""

import copy
import pathlib
import subprocess
import sys
import unittest
import uuid

import batch_replacement_report as replacement
import report_test
import held_status_report_fixture as fixture


class ReplacementReportTests(unittest.TestCase):
    def setUp(self):
        fixture.prepare_batch_replacement(self, replacement.CASES)

    def event(self,phase):
        return report_test.witness_for_phase(self.witnesses, phase)

    def write(self):
        fixture.write_batch_replacement(self)

    def validate(self):
        self.write()
        return replacement.validate(self.root)

    def refused(self,changes):
        original = copy.deepcopy(self.witnesses)
        report_test.assert_indexed_witness_refusals(self, original, changes)

    def test_both_cases_preserve_explicit_evidence_limits(self):
        result = self.validate()
        self.assertEqual(set(result["cases"]),replacement.CASES)
        self.assertTrue(result["native_batch_replacement_complete"])
        for key in ("memory_envelope_calibrated","production_protection_proven","bootstrap_provenance_verified",
                    "incoming_required_history_proven"):
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
