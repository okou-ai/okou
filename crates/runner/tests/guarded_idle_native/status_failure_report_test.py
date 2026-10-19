#!/usr/bin/env python3
"""Synthetic real-file/CLI consumer regressions, not native execution evidence."""

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
import report_test
import status_failure_report as failure


class StatusFailureReportTests(unittest.TestCase):
    def setUp(self):
        report_test.NativeReportTests.setUp(self)
        gib = 1024**3
        self.policy = {
            "host_total_bytes": 64*gib, "operating_floor_bytes": gib,
            "cleanup_reserve_bytes": 256*1024**2, "critical_available_bytes": 12*gib,
            "recovery_available_bytes": 20*gib, "live_growth_bytes": 4*1024**2,
            "tail_growth_bytes": 65*1024**2, "replacement_preparation_bytes": 32*1024**2,
            "max_sample_age_millis": 1000, "max_operations": 8, "max_cleanup_inflight": 2,
            "pressure_sample_period_millis": 50, "pressure_recovery_sustain_millis": 100,
            "pressure_wave_cooldown_millis": 100, "pressure_optional_start_interval_millis": 100,
            "pressure_max_wave_entries": 1,
        }
        raw = json.dumps(self.policy)
        self.artifacts["policy_sha256"] = hashlib.sha256(raw.encode()).hexdigest()
        self.collector["metadata"]["native_status_failure_policy_json"] = raw
        originals, sample = self.events, self.samples[0]
        self.events, self.samples, self.witnesses = [], [], []
        for index, case in enumerate(sorted(failure.CASES)):
            base = 10_000_000_000 * (index + 1)
            at = lambda offset: base + offset*1_000_000
            terminal = copy.deepcopy(originals[index*6:index*6+6])
            for event, clock in zip(terminal, (0, 1, 2, 3, 20, 50)):
                event.update(case=case, monotonic_ns=at(clock), unix_ns=at(clock)+1000)
                reading = copy.deepcopy(sample)
                reading["monotonic_ns"] = at(clock)+1
                reading["processes"][0]["observed_monotonic_ns"] = at(clock)+1
                self.samples.append(reading)
            self.events.extend(terminal)
            accounts = {k: 0 for k in cleanup.COUNTS} | {"closed": True}
            active = accounts | {"registered_operations": 1, "started": 1,
                                 "cleanup_growth_bytes": self.policy["tail_growth_bytes"], "tracked_tasks": 1}
            covered = {"allocated": [2,4096,1], "accounting": active,
                       "original_lease_active": True, "io_release_withheld": True}
            first = copy.deepcopy(covered)
            first["accounting"]["closed"] = False
            runner = str(uuid.uuid4())
            def heartbeat(sequence, received, finished, allocated):
                return {"receipt": {"received_ns": at(received), "acknowledgement_status": 204,
                    "state": {"runnerId": runner, "snapshotGeneration": 1, "snapshotSequence": sequence,
                        "group": "native-foreground", "mode": "running", "allocatedVcpu": allocated[0],
                        "allocatedMemoryMb": allocated[1]}}, "send_joined": True, "completed_ns": at(finished)}
            baseline = {"mode": "starting", "max_concurrent": 1, "active_runs": [],
                "started_at": "2026-10-18T16:00:00Z", "updated_at": "2026-10-18T16:00:10Z",
                "idle_sandboxes": [{"reuse_key": "thread:native-guarded-"+str(uuid.uuid4()),
                                    "sandbox_id": terminal[1]["sandbox_id"]}]}
            retried = {k:v for k,v in baseline.items() if k != "idle_sandboxes"}
            retried["updated_at"] = "2026-10-18T16:00:20Z"
            status_path = str(self.root/f"case-{index}"/"status.json")
            values = (
                {"policy": self.policy, "published_status": baseline, "status_path": status_path,
                    "receiver_polled_pending": True, "coverage": first},
                {"pool_held_ns": at(6), "status_held_ns": at(7), "heartbeat_pending_ns": at(8),
                    "heartbeat_polled_pending": True, "observer": {"started_ns": at(9),
                        "completed_ns": at(10), "available_bytes": 32*gib, "age_ns": 2,
                        "read_duration_ns": 1, "joined": True}, "tracker_shutdown_pending": True,
                    "accounting_shutdown_pending": True, "coverage": covered},
                {"pool_released_ns": at(13), "status_held_ns": at(7),
                    "heartbeat": heartbeat(1,14,15,(2,4096)), "receiver_polled_pending": True,
                    "tracker_shutdown_pending": True, "accounting_shutdown_pending": True, "coverage": covered},
                {"io_released_ns": at(17), "status_held_ns": at(7), "status_wait_polled_ns": at(21),
                    "status_waits_before": 0, "status_waits_after": 1, "receiver_polled_pending": True,
                    "tracker_shutdown_pending": True, "accounting_joined": True, "accounting": accounts,
                    "allocated": [0,0,0], "heartbeat": heartbeat(2,22,23,(0,0)),
                    "fault_injected_ns": at(24), "status_destination_directory": True},
                {"status_released_ns": at(26), "batch_joined_ns": at(27), "selected": 1, "completed": 1,
                    "uncertain": 0, "not_started": 0, "is_complete": False, "status_error_kind": "write",
                    "status_error_path": status_path, "status_destination_directory": True},
                {"retry_started_ns": at(32), "retry_completed_ns": at(33), "published_status": retried,
                    "regular_file": True, "original_batch_complete": False},
                {"batch_joined": True, "tracker_joined": True, "accounting_joined": True,
                    "heartbeat_joined": True, "provider_joined": True, "peer_joined": True,
                    "remaining_activation_owners": 0, "remaining_finalizing_owners": 0,
                    "allocated": [0,0,0], "accounting": accounts},
            )
            for phase, value, clock in zip(failure.PHASES, values, (4,12,16,25,30,40,45)):
                self.witnesses.append({"version": 1, "case": case, "phase": phase,
                    "monotonic_ns": at(clock), "unix_ns": at(clock)+1000,
                    "sandbox_id": terminal[1]["sandbox_id"], "backing_generation": terminal[1]["backing_generation"],
                    "evidence": copy.deepcopy(value)})

    def write(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(s) for s in self.samples))
        (self.root/"stdout.log").write_text("\n".join(
            [report.PREFIX+json.dumps(e) for e in self.events]
            + [failure.PREFIX+json.dumps(e) for e in self.witnesses]))

    def validate(self):
        self.write()
        return failure.validate(self.root)

    def refused(self, changes):
        original = copy.deepcopy(self.witnesses)
        for index, change in enumerate(changes):
            with self.subTest(change=index):
                self.witnesses = copy.deepcopy(original)
                change()
                with self.assertRaises(ValueError):
                    self.validate()

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
