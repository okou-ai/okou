#!/usr/bin/env python3
"""Synthetic real-file/CLI consumer regressions, not native execution evidence."""

import copy
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

import held_status_report_fixture as fixture
import report
import report_test
import status_failure_report as failure


class StatusFailureReportTests(unittest.TestCase):
    def setUp(self):
        fixture.prepare_status_failure(self)

    def write(self):
        report_test.write_report_fixture(self.root, self.collector, self.samples,
            [(report.PREFIX, self.events), (failure.PREFIX, self.witnesses)])

    def validate(self):
        self.write()
        return failure.validate(self.root)

    def refused(self, changes):
        original = copy.deepcopy(self.witnesses)
        report_test.assert_indexed_witness_refusals(self, original, changes)

    def test_both_cases_preserve_original_and_measurement_limits(self):
        value = self.validate()
        self.assertEqual(set(value["cases"]), failure.CASES)
        self.assertTrue(value["native_cleanup_status_failure_complete"])
        for key in ("memory_envelope_calibrated", "production_protection_proven", "bootstrap_provenance_verified"):
            self.assertIs(value[key], False)

    def test_real_cli_requires_complete_original_evidence(self):
        self.write()
        command = [sys.executable, str(pathlib.Path(__file__).with_name("status_failure_report.py")), str(self.root)]
        result = subprocess.run(command, capture_output=True, check=True, timeout=5)
        self.assertTrue(json.loads(result.stdout)["native_cleanup_status_failure_complete"])
        self.witnesses.pop()
        self.write()
        self.assertNotEqual(subprocess.run(command, capture_output=True, timeout=5).returncode, 0)
        with (self.root/"stdout.log").open("a") as output:
            output.write("\n"+failure.PREFIX+'{"version":')
        self.assertNotEqual(subprocess.run(command, capture_output=True, timeout=5).returncode, 0)

    def test_phase_completeness_order_shape_and_identity(self):
        self.refused((lambda: self.witnesses.pop(2),
            lambda: self.witnesses.append(copy.deepcopy(self.witnesses[-1])),
            lambda: self.witnesses[1].update(phase="tail_blocked"),
            lambda: self.witnesses[2].update(sandbox_id=str(uuid.uuid4())),
            lambda: self.witnesses[3].update(backing_generation=str(uuid.uuid4())),
            lambda: self.witnesses[0].update(version=True),
            lambda: self.witnesses[0].update(case=[]),
            lambda: self.witnesses[0].update(case={}),
            lambda: self.witnesses[0].update(extra="unbound")))

    def test_original_nonempty_status_must_belong_to_original_sandbox(self):
        self.refused((lambda: self.witnesses[0]["evidence"]["published_status"].pop("idle_sandboxes"),
            lambda: self.witnesses[0]["evidence"]["published_status"]["idle_sandboxes"][0].update(sandbox_id=str(uuid.uuid4())),
            lambda: self.witnesses[0]["evidence"]["published_status"].update(blank_sandboxes=[]),
            lambda: self.witnesses[0]["evidence"]["published_status"].update(max_concurrent=True),
            lambda: self.witnesses[0]["evidence"].update(status_path="../status.json"),
            lambda: self.witnesses[7]["evidence"].update(status_path=self.witnesses[0]["evidence"]["status_path"])))

    def test_every_held_phase_retains_original_full_lease_and_growth(self):
        changes = [lambda i=i,k=k,v=v: self.witnesses[i]["evidence"]["coverage"].update({k:v})
            for i in range(3) for k,v in (("allocated",[0,0,0]),("original_lease_active",False),("io_release_withheld",False))]
        changes += [lambda i=i,k=k,v=v: self.witnesses[i]["evidence"]["coverage"]["accounting"].update({k:v})
            for i in range(3) for k,v in (("registered_operations",0),("started",0),("tracked_tasks",0),
                ("cleanup_growth_bytes",0),("ordinary_growth_bytes",1),("uncertain",1))]
        self.refused(changes)

    def test_pending_original_completion_and_shutdown_are_required(self):
        self.refused([lambda i=i,k=k: self.witnesses[i]["evidence"].update({k:False}) for i,keys in (
            (0,("receiver_polled_pending",)),(1,("heartbeat_polled_pending","tracker_shutdown_pending","accounting_shutdown_pending")),
            (2,("receiver_polled_pending","tracker_shutdown_pending","accounting_shutdown_pending")),
            (3,("receiver_polled_pending","tracker_shutdown_pending","accounting_joined"))) for k in keys])

    def test_independent_observation_and_acknowledged_heartbeats_are_required(self):
        self.refused((lambda: self.witnesses[1]["evidence"]["observer"].update(joined=False),
            lambda: self.witnesses[2]["evidence"]["heartbeat"]["receipt"].update(acknowledgement_status=200),
            lambda: self.witnesses[3]["evidence"]["heartbeat"]["receipt"]["state"].update(snapshotSequence=1),
            lambda: self.witnesses[3]["evidence"]["heartbeat"]["receipt"]["state"].update(runnerId=str(uuid.uuid4())),
            lambda: self.witnesses[3]["evidence"]["heartbeat"]["receipt"]["state"].update(allocatedVcpu=2)))

    def test_fault_requires_complete_tail_positive_status_wait_and_settled_accounting(self):
        self.refused((lambda: self.witnesses[3]["evidence"].update(status_wait_polled_ns=self.events[4]["monotonic_ns"]),
            lambda: self.witnesses[3]["evidence"].update(status_waits_after=0),
            lambda: self.witnesses[3]["evidence"].update(fault_injected_ns=self.witnesses[2]["monotonic_ns"]),
            lambda: self.witnesses[3]["evidence"].update(allocated=[2,4096,1]),
            lambda: self.witnesses[3]["evidence"]["accounting"].update(tracked_tasks=1)))

    def test_physical_completion_cannot_hide_or_replace_write_failure(self):
        self.refused([lambda k=k,v=v: self.witnesses[4]["evidence"].update({k:v}) for k,v in (
            ("selected",0),("completed",0),("uncertain",1),("not_started",1),("is_complete",True),
            ("status_error_kind","timeout"),("status_error_path","/different/status.json"),
            ("status_destination_directory",False),("completed",True),
            ("batch_joined_ns",self.witnesses[3]["monotonic_ns"]))])

    def test_retry_cannot_republish_old_inventory_or_rewrite_failed_report(self):
        self.refused((lambda: self.witnesses[5]["evidence"].update(published_status=copy.deepcopy(self.witnesses[0]["evidence"]["published_status"])),
            lambda: self.witnesses[5]["evidence"].update(regular_file=False),
            lambda: self.witnesses[5]["evidence"].update(original_batch_complete=True),
            lambda: self.witnesses[5]["evidence"].update(retry_started_ns=self.witnesses[4]["monotonic_ns"]),
            lambda: self.witnesses[5]["evidence"]["published_status"].update(started_at="2026-10-18T16:00:01Z")))

    def test_all_producers_and_retained_owners_must_settle(self):
        self.refused([lambda k=k: self.witnesses[6]["evidence"].update({k:False}) for k in (
            "batch_joined","tracker_joined","accounting_joined","heartbeat_joined","provider_joined","peer_joined")]
            + [lambda: self.witnesses[6]["evidence"].update(remaining_activation_owners=1),
               lambda: self.witnesses[6]["evidence"]["accounting"].update(uncertain=1)])

    def test_original_raw_policy_identity_is_required(self):
        self.collector["metadata"]["native_status_failure_policy_json"] += " "
        with self.assertRaises(ValueError):
            self.validate()

    def test_actual_preparation_record_is_required(self):
        (self.root/"snapshot-preparation.json").unlink()
        with self.assertRaises(ValueError):
            self.validate()

    def test_duplicate_original_json_members_are_refused(self):
        self.write()
        path = self.root/"stdout.log"
        path.write_text(path.read_text().replace('"status_error_kind": "write"',
            '"status_error_kind": "timeout", "status_error_kind": "write"', 1))
        with self.assertRaises(ValueError):
            failure.validate(self.root)


if __name__ == "__main__":
    unittest.main()
