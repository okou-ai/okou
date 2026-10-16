#!/usr/bin/env python3
"""Real-file/CLI refusals for full-budget logical transfer and physical progress."""

import copy
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

import foreground_report_test
import logical_report as logical
import report


class LogicalReportTests(unittest.TestCase):
    def setUp(self):
        foreground_report_test.ForegroundReportTests.setUp(self)
        metadata = self.collector["metadata"]
        for field in ("policy_json", "inputs_json", "snapshot_bytes"):
            metadata["native_logical_"+field] = metadata["native_foreground_"+field]
        existing = self.witnesses[:12]
        self.events = self.events[:12]
        self.witnesses = []
        for offset, case in enumerate(sorted(logical.CASES)):
            terminal = self.events[offset*6:offset*6+6]
            for event in terminal:
                event["case"] = case
            old = existing[offset*6:offset*6+6]
            start, tail = terminal[1]["monotonic_ns"], terminal[3]["monotonic_ns"]
            original = [copy.deepcopy(e["evidence"]) for e in old]
            initial, pool, status, prepared, blocked, joined = original
            operation = prepared["operation_id"]
            initial.pop("kind")
            initial.update(profile_can_fit=False, physical_credit_from_logical_transfer=False,
                fresh_grant={"started_ns": start+1_000_000, "finished_ns": start+5_000_000,
                    "operation_id": operation, "samples": [{"started_ns": start+2_000_000,
                        "finished_ns": start+2_000_003, "read_start_offset_ns": 1,
                        "available_bytes": 32*1024**3, "age_ns": 2, "read_duration_ns": 1}]})
            pool = {k: pool[k] for k in ("startup", "startup_drained", "reads", "state",
                "pool_held_ns", "status_held_ns", "observer")}
            pool.update(pool_wait_polled_ns=start+35_000_000, pool_wait_polled_pending=True, allocated=[2,4096,1])
            status.pop("status_held")
            status.pop("foreground_status_wait_polled")
            status.update(pool_released_ns=start+400_000_000, status_wait_polled_ns=start+410_000_000,
                runtime_completed_ns=start+380_000_000, status_waits_before=0, status_waits_after=1,
                actual_idle_snapshot_wait=True, allocated=[2,4096,1], logical_lease_transferred=True,
                original_full_lease_retained=True, profile_can_fit=False, inventory_empty=True)
            status["heartbeat"]["receipt"]["received_ns"] = start+430_000_000
            status["heartbeat"]["completed_ns"] = start+440_000_000
            status["observer"]["started_ns"] = start+450_000_000
            status["observer"]["completed_ns"] = start+470_000_000
            prepared.pop("kind")
            prepared.pop("run_id")
            prepared.pop("original_owner_preserved")
            prepared.update(backing_generation=str(uuid.uuid4()), new_backing_exit_confirmed=True,
                logical_lease_transferred=True, refresh={"started_ns": start+510_000_000,
                    "finished_ns": start+520_000_000, "available_bytes": 32*1024**3,
                    "age_ns": 2, "read_duration_ns": 1})
            joining = {"polled_ns": start+690_000_000, "retirements": 1,
                "allocated": [2,4096,1], "old_exit_dependency_added": False}
            blocked["full_logical_lease"] = blocked.pop("full_original_lease")
            blocked["old_join_polled_ns"] = joining["polled_ns"]
            joined.pop("foreground_joined")
            joined.update(logical_work_joined=True, allocated=[2,4096,1],
                original_full_lease_retained=True, physical_credit_from_logical_transfer=False)
            values = (initial, pool, status, prepared, joining, blocked, joined)
            clocks = (start+10_000_000, start+100_000_000, start+500_000_000,
                start+600_000_000, start+700_000_000, tail+100_000_000,
                terminal[4]["monotonic_ns"]+100_000_000)
            for phase, value, clock in zip(logical.PHASES, values, clocks):
                self.witnesses.append({"version": 1, "case": case, "phase": phase,
                    "monotonic_ns": clock, "unix_ns": clock+1000,
                    "sandbox_id": terminal[1]["sandbox_id"], "backing_generation": terminal[1]["backing_generation"],
                    "evidence": value})

    def write(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(s) for s in self.samples))
        (self.root/"stdout.log").write_text("\n".join([report.PREFIX+json.dumps(e) for e in self.events]
            + [logical.PREFIX+json.dumps(e) for e in self.witnesses]))

    def validate(self):
        self.write()
        return logical.validate(self.root)

    def refused(self, changes):
        original = copy.deepcopy(self.witnesses)
        for change in changes:
            self.witnesses = copy.deepcopy(original)
            change()
            with self.assertRaises(ValueError):
                self.validate()

    def test_both_complete_modes_preserve_claim_limits(self):
        value = self.validate()
        self.assertTrue(value["native_logical_progress_complete"])
        self.assertEqual(set(value["cases"]), logical.CASES)
        self.assertFalse(value["production_protection_proven"])
        self.assertFalse(value["startup_pressure_guarded"])

    def test_real_cli_requires_complete_original_files(self):
        self.write()
        command = [sys.executable, str(pathlib.Path(__file__).with_name("logical_report.py")), str(self.root)]
        self.assertTrue(json.loads(subprocess.check_output(command))["native_logical_progress_complete"])
        self.witnesses.pop()
        self.write()
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_missing_duplicate_order_and_original_identity_are_refused(self):
        self.refused((lambda: self.witnesses.pop(2),
            lambda: self.witnesses.append(copy.deepcopy(self.witnesses[-1])),
            lambda: self.witnesses[0].update(phase="status_wait_progress"),
            lambda: self.witnesses[3].update(backing_generation=str(uuid.uuid4()))))

    def test_logical_capacity_cannot_replace_actual_fresh_coverage(self):
        self.refused((lambda: self.witnesses[0]["evidence"].update(physical_credit_from_logical_transfer=True),
            lambda: self.witnesses[0]["evidence"].update(fresh_grant=None),
            lambda: self.witnesses[0]["evidence"]["fresh_grant"]["samples"][0].update(age_ns=1_000_000_000),
            lambda: self.witnesses[3]["evidence"].update(operation_id=str(uuid.uuid4()))))

    def test_complete_startup_runtime_and_unknown_suppression_are_required(self):
        self.refused((lambda: self.witnesses[1]["evidence"]["startup"].update(read_bytes=1),
            lambda: self.witnesses[1]["evidence"]["reads"].update(accepted=1),
            lambda: self.witnesses[2]["evidence"]["reads"].update(cancelled=1),
            lambda: self.witnesses[2]["evidence"].update(samples=[self.witnesses[2]["evidence"]["samples"][0]]),
            lambda: self.witnesses[2]["evidence"].update(runtime_completed_ns=self.witnesses[2]["evidence"]["pool_released_ns"])))

    def test_specific_pending_status_wait_and_original_full_transfer_are_required(self):
        self.refused(tuple(lambda key=key: self.witnesses[2]["evidence"].update({key: None}) for key in (
            "actual_idle_snapshot_wait", "status_waits_before", "status_waits_after", "status_wait_polled_ns",
            "logical_lease_transferred", "original_full_lease_retained", "allocated", "profile_can_fit", "inventory_empty")))

    def test_fresh_refresh_distinct_guest_rpc_and_positive_exit_are_required(self):
        self.refused((lambda: self.witnesses[3]["evidence"]["refresh"].update(started_ns=self.witnesses[2]["monotonic_ns"]),
            lambda: self.witnesses[3]["evidence"]["refresh"].update(age_ns=1_000_000_000),
            lambda: self.witnesses[3]["evidence"].update(sandbox_id=self.witnesses[3]["sandbox_id"]),
            lambda: self.witnesses[3]["evidence"].update(new_backing_exit_confirmed=False),
            lambda: self.witnesses[3]["evidence"].update(guest_rpc_completed=False)))

    def test_join_and_blocked_io_need_independent_acknowledged_progress(self):
        self.refused((lambda: self.witnesses[4]["evidence"].update(old_exit_dependency_added=True),
            lambda: self.witnesses[4]["evidence"].update(polled_ns=self.witnesses[3]["monotonic_ns"]),
            lambda: self.witnesses[5]["evidence"].update(release_byte_withheld=False),
            lambda: self.witnesses[5]["evidence"]["heartbeat"]["receipt"].update(acknowledgement_status=500),
            lambda: self.witnesses[2]["evidence"]["observer"].update(joined=False)))

    def test_every_accepted_owner_and_lease_must_join(self):
        self.refused(tuple(lambda key=key: self.witnesses[6]["evidence"].update({key: None}) for key in (
            "startup_drained", "runtime_drained", "logical_work_joined", "pressure_stopped", "heartbeat_joined",
            "provider_joined", "peer_joined", "snapshot_reverified", "original_full_lease_retained", "tracked_tasks")))

    def test_inherited_physical_completion_cannot_be_replaced_by_progress(self):
        self.events[4]["evidence"]["written_and_verified_bytes"] = 1
        with self.assertRaises(ValueError):
            self.validate()


if __name__ == "__main__":
    unittest.main()
