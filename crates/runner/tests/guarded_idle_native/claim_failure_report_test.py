#!/usr/bin/env python3
"""Real-file/CLI consumer contracts; these synthetic files are not native proof."""
import copy
import json
import pathlib
import re
import subprocess
import sys
import unittest
import uuid

import claim_failure_report as failure
import claim_loss_report_test as c7_test


class ClaimFailureReportTests(unittest.TestCase):
    write = c7_test.ClaimLossReportTests.write
    event = c7_test.ClaimLossReportTests.event
    refused = c7_test.ClaimLossReportTests.refused

    def setUp(self):
        c7_test.ClaimLossReportTests.setUp(self)
        raw = self.collector["metadata"].pop("native_claim_loss_policy_json")
        self.collector["metadata"]["native_claim_failure_policy_json"] = raw
        events, witnesses, samples = self.events, self.witnesses, self.samples
        self.events, self.witnesses, self.samples = [], [], []
        for index, fault in enumerate(("decode", "disconnect")):
            text = json.dumps([events, witnesses])
            identities = {value: str(uuid.uuid4()) for value in
                          set(re.findall(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", text))}

            def remap(value, key=""):
                if isinstance(value, dict):
                    return {k: remap(v, k) for k, v in value.items()}
                if isinstance(value, list):
                    return [remap(v) for v in value]
                if isinstance(value, str):
                    for old, new in identities.items():
                        value = value.replace(old, new)
                    return value.replace("ClaimLoss-", f"ClaimUnavailable-{fault}-").replace(
                        str(self.root/"case-"), str(self.root/f"{fault}-case-"))
                if type(value) is int and key.endswith("_ns") and key not in ("age_ns", "read_duration_ns"):
                    return value + index*30_000_000_000
                return value

            self.events.extend(remap(events))
            current = remap(witnesses)
            for event in current:
                if event["phase"] == "claim_rejected":
                    event["evidence"]["receipt"].update(failure.OUTCOMES[event["case"]])
            self.witnesses.extend(current)
            self.samples.extend(remap(samples))

    def validate(self):
        self.write()
        return failure.validate(self.root)

    def test_complete_both_faults_and_modes_do_not_claim_remote_rejection_or_producer_loss(self):
        result = self.validate()
        self.assertEqual(set(result["cases"]), failure.CASES)
        self.assertTrue(result["native_provider_failure_rollback_complete"])
        for field in ("api_claim_404_rejection_proven", "actual_api_claim_loss_proven",
                      "remote_non_claim_proven", "producer_loss_proven", "production_protection_proven"):
            self.assertIs(result[field], False)

    def test_cli_reads_original_files_and_requires_every_fault_case(self):
        self.write()
        command = [sys.executable, str(pathlib.Path(__file__).with_name("claim_failure_report.py")), str(self.root)]
        self.assertEqual(subprocess.run(command, capture_output=True).returncode, 0)
        self.witnesses.pop()
        self.write()
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_transport_and_decode_cannot_be_relabelled_404_or_panic(self):
        self.refused((
            lambda: self.event("claim_rejected")["evidence"]["receipt"].update(status=404),
            lambda: self.event("claim_rejected")["evidence"]["receipt"].update(response_body_hex="7d"),
            lambda: self.event("claim_rejected")["evidence"].update(producer_lost=True),
            lambda: self.event("claim_rejected")["evidence"].update(claim_unavailable=False),
        ))

    def test_original_authority_full_lease_saving_and_joins_are_required(self):
        self.refused((
            lambda: self.event("claim_waiting")["evidence"]["request"].update(path="/other"),
            lambda: self.event("claim_wait_progress")["evidence"].update(allocated=[0,0,0]),
            lambda: self.event("claim_rejected")["evidence"].update(guest_preparation_completed=False),
            lambda: self.event("tail_wait_progress")["evidence"]["coverage"].update(original_lease_active=False),
            lambda: self.event("original_completed")["evidence"].update(completed=0),
            lambda: self.event("producers_joined")["evidence"].update(provider_joined=False),
        ))

    def test_missing_duplicate_replayed_identity_and_clock_are_refused(self):
        self.refused((lambda: self.witnesses.pop(),
            lambda: self.witnesses.insert(1, copy.deepcopy(self.witnesses[0])),
            lambda: self.witnesses[1].update(backing_generation=str(uuid.uuid4())),
            lambda: self.witnesses[0].update(monotonic_ns=1)))


if __name__ == "__main__":
    unittest.main()
