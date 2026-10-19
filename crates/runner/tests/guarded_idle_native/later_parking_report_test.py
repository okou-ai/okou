#!/usr/bin/env python3
"""Synthetic original-file/CLI regressions; these fixtures are not native proof."""

import copy
import hashlib
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

import cleanup_report as cleanup
import later_parking_report as later
import report
import status_failure_report_test as failure_test


class LaterParkingReportTests(unittest.TestCase):
    def setUp(self):
        failure_test.StatusFailureReportTests.setUp(self)
        raw = json.dumps(self.policy)
        self.collector["metadata"].pop("native_status_failure_policy_json")
        self.collector["metadata"]["native_later_parking_policy_json"] = raw
        self.artifacts["policy_sha256"] = hashlib.sha256(raw.encode()).hexdigest()
        original, sample = self.events[:6], self.samples[0]
        self.events, self.samples, self.witnesses = [], [], []
        for index, case in enumerate(sorted(later.CASES)):
            at = lambda offset: 10_000_000_000*(index+1) + offset*1_000_000
            old, backing, new, new_backing, operation, runner = [str(uuid.uuid4()) for _ in range(6)]
            terminal = copy.deepcopy(original)
            for event, offset in zip(terminal, (0,1,5,6,25,60)):
                event.update(case=case, sandbox_id=old, backing_generation=backing,
                             monotonic_ns=at(offset), unix_ns=at(offset)+1000)
                reading = copy.deepcopy(sample)
                reading["monotonic_ns"] = at(offset)+1
                reading["processes"][0]["observed_monotonic_ns"] = at(offset)+1
                self.samples.append(reading)
            self.events.extend(terminal)
            zero = dict.fromkeys(cleanup.COUNTS, 0) | {"closed": False}
            active = zero | {"registered_operations": 1, "started": 1, "tracked_tasks": 1,
                             "cleanup_growth_bytes": self.policy["tail_growth_bytes"]}
            coverage = {"allocated": [4,8192,2], "accounting": active,
                        "original_lease_active": True, "io_release_withheld": True}
            initial = {"mode": "starting", "max_concurrent": 1, "active_runs": [],
                "started_at": "2026-10-19T01:00:00Z", "updated_at": "2026-10-19T01:00:01Z",
                "idle_sandboxes": [{"reuse_key": "thread:native-guarded-"+str(uuid.uuid4()), "sandbox_id": old}]}
            reuse = "thread:native-later-"+str(uuid.uuid4())
            blank = case.startswith("LaterBlank-")
            current = {k:v for k,v in initial.items() if k != "idle_sandboxes"}
            current["updated_at"] = "2026-10-19T01:00:02Z"
            current["blank_sandboxes" if blank else "idle_sandboxes"] = (
                [{"sandbox_id":new}] if blank else [{"reuse_key":reuse,"sandbox_id":new}])
            empty = {k:v for k,v in current.items() if k not in ("idle_sandboxes", "blank_sandboxes")}
            empty["updated_at"] = "2026-10-19T01:00:03Z"
            def heartbeat(sequence, begin, end, allocated):
                return {"receipt":{"received_ns":at(begin),"acknowledgement_status":204,
                    "state":{"runnerId":runner,"snapshotGeneration":1,"snapshotSequence":sequence,
                        "group":"native-foreground","mode":"running","allocatedVcpu":allocated[0],
                        "allocatedMemoryMb":allocated[1]}},"send_joined":True,"completed_ns":at(end)}
            values = (
                {"policy":self.policy,"published_status":initial,"status_path":str(self.root/f"case-{index}"/"status.json"),
                 "receiver_polled_pending":True,"preparation":{"sandbox_id":new,"backing_generation":new_backing,
                    "operation_id":operation,"grant_started_ns":at(2),"grant_finished_ns":at(3),"prepared_ns":at(4),
                    "guest_rpc_completed":True,"phase_settled":True,"separate_incoming_lease":True},
                 "later_reuse_key":reuse,"blank":blank,"profile_name":"vm0/default","coverage":coverage},
                {"inserted_ns":at(9),"revision":3,"pool_held_ns":at(10),"status_held_ns":at(11),
                 "heartbeat_pending_ns":at(12),"heartbeat_polled_pending":True,
                 "observer":{"started_ns":at(13),"completed_ns":at(14),"available_bytes":32*1024**3,
                    "age_ns":2,"read_duration_ns":1,"joined":True},"coverage":coverage},
                {"pool_released_ns":at(17),"heartbeat":heartbeat(1,18,19,(4,8192)),
                 "receiver_polled_pending":True,"coverage":coverage},
                {"io_released_ns":at(22),"status_wait_polled_ns":at(26),"status_waits_before":0,"status_waits_after":1,
                 "receiver_polled_pending":True,"original_exit_confirmed":True,"original_lease_released":True,
                 "later_exit_polled_pending":True,"allocated":[2,4096,1],"accounting":zero,
                 "heartbeat":heartbeat(2,27,28,(2,4096))},
                {"status_released_ns":at(32),"batch_joined_ns":at(33),"selected":1,"completed":1,"uncertain":0,
                 "not_started":0,"status_error":False,"is_complete":True,"revision":3,"published_status":current,
                 "regular_file":True,"later_exit_polled_pending":True,"allocated":[2,4096,1]},
                {"started_ns":at(37),"joined_ns":at(38),"selected":1,"completed":1,"uncertain":0,
                 "not_started":0,"status_error":False,"is_complete":True,"later_exit_confirmed":True,
                 "published_status":empty,"allocated":[0,0,0]},
                {"batch_joined":True,"later_batch_joined":True,"tracker_joined":True,"accounting_joined":True,
                 "heartbeat_joined":True,"provider_joined":True,"peer_joined":True,
                 "remaining_activation_owners":0,"remaining_finalizing_owners":0,
                 "allocated":[0,0,0],"accounting":zero|{"closed":True}},
            )
            for phase, value, offset in zip(later.PHASES, values, (8,16,21,30,35,40,45)):
                self.witnesses.append({"version":1,"case":case,"phase":phase,"monotonic_ns":at(offset),
                    "unix_ns":at(offset)+1000,"sandbox_id":old,"backing_generation":backing,"evidence":copy.deepcopy(value)})

    def event(self, phase, case=None):
        return next(e for e in self.witnesses if e["phase"] == phase and (case is None or e["case"] == case))

    def write(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(s) for s in self.samples))
        (self.root/"stdout.log").write_text("\n".join([report.PREFIX+json.dumps(e) for e in self.events]
            + [later.PREFIX+json.dumps(e) for e in self.witnesses]))

    def validate(self):
        self.write()
        return later.validate(self.root)

    def refused(self, changes):
        original = copy.deepcopy(self.witnesses)
        for index, change in enumerate(changes):
            with self.subTest(change=index):
                self.witnesses = copy.deepcopy(original)
                change()
                with self.assertRaises(ValueError):
                    self.validate()

    def test_all_four_cases_retain_measurement_limits(self):
        value = self.validate()
        self.assertEqual(set(value["cases"]), later.CASES)
        self.assertTrue(value["native_later_parking_complete"])
        for key in ("memory_envelope_calibrated", "production_protection_proven", "bootstrap_provenance_verified"):
            self.assertIs(value[key], False)

    def test_cli_reads_original_files_and_refuses_missing_case(self):
        self.write()
        command = [sys.executable, str(pathlib.Path(__file__).with_name("later_parking_report.py")), str(self.root)]
        self.assertEqual(subprocess.run(command, capture_output=True).returncode, 0)
        self.witnesses.pop(); self.write()
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_omitted_duplicate_phases_and_owner_replays_are_refused(self):
        self.refused((lambda:self.witnesses.pop(0), lambda:self.witnesses.insert(1,copy.deepcopy(self.witnesses[0])),
            lambda:self.witnesses[1].update(sandbox_id=str(uuid.uuid4())),
            lambda:self.event("tail_blocked")["evidence"]["preparation"].update(sandbox_id=self.witnesses[0]["sandbox_id"])))

    def test_preparation_admission_and_contention_order_are_required(self):
        self.refused((lambda:self.event("tail_blocked")["evidence"]["preparation"].update(guest_rpc_completed=False),
            lambda:self.event("tail_blocked")["evidence"]["preparation"].update(prepared_ns=self.witnesses[0]["monotonic_ns"]),
            lambda:self.event("pool_wait_progress")["evidence"].update(heartbeat_polled_pending=False),
            lambda:self.event("pool_wait_progress")["evidence"]["observer"].update(joined=False),
            lambda:self.event("tail_wait_progress")["evidence"]["heartbeat"]["receipt"].update(acknowledgement_status=500)))

    def test_both_full_leases_and_saving_growth_are_required(self):
        self.refused((lambda:self.event("tail_blocked")["evidence"]["coverage"].update(allocated=[2,4096,1]),
            lambda:self.event("tail_wait_progress")["evidence"]["coverage"].update(original_lease_active=False),
            lambda:self.event("tail_wait_progress")["evidence"]["coverage"]["accounting"].update(cleanup_growth_bytes=0),
            lambda:self.event("status_wait_progress")["evidence"].update(original_lease_released=False),
            lambda:self.event("status_wait_progress")["evidence"]["accounting"].update(closed=True)))

    def test_current_inventory_fixed_report_and_separate_retirement_are_required(self):
        self.refused((lambda:self.event("original_completed")["evidence"].update(selected=2),
            lambda:self.event("original_completed")["evidence"].update(revision=4),
            lambda:self.event("original_completed")["evidence"].update(published_status=self.event("tail_blocked")["evidence"]["published_status"]),
            lambda:self.event("original_completed")["evidence"].update(later_exit_polled_pending=False),
            lambda:self.event("later_retired")["evidence"].update(selected=0),
            lambda:self.event("later_retired")["evidence"].update(later_exit_confirmed=False),
            lambda:self.event("producers_joined")["evidence"].update(remaining_activation_owners=1)))

    def test_original_home_and_raw_policy_identity_are_required(self):
        self.events[-1]["evidence"]["original_home_restored"] = False
        with self.assertRaises(ValueError): self.validate()
        self.events[-1]["evidence"]["original_home_restored"] = True
        self.collector["metadata"]["native_later_parking_policy_json"] += " "
        with self.assertRaises(ValueError): self.validate()


if __name__ == "__main__":
    unittest.main()
