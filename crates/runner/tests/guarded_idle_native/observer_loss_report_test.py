#!/usr/bin/env python3
"""Real-file/CLI refusals for native cleanup-observer drop and panic."""

import copy
import hashlib
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

import observer_loss_report as loss
import report
import report_test


class ObserverLossReportTests(unittest.TestCase):
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
        self.collector["metadata"]["native_observer_loss_policy_json"] = raw
        originals, sample = self.events, self.samples[0]
        self.events, self.samples, self.witnesses = [], [], []
        for index, case in enumerate(sorted(loss.CASES)):
            base = 10_000_000_000 * (index + 1)
            at = lambda offset: base + offset*1_000_000
            terminal = copy.deepcopy(originals[index*6:index*6+6])
            for event, clock in zip(terminal, (0, 1, 2, 3, 20, 30)):
                event.update(case=case, monotonic_ns=at(clock), unix_ns=at(clock)+1000)
                reading = copy.deepcopy(sample)
                reading["monotonic_ns"] = at(clock)+1
                reading["processes"][0]["observed_monotonic_ns"] = at(clock)+1
                self.samples.append(reading)
            self.events.extend(terminal)
            accounts = {k: 0 for k in loss.COUNTS} | {"closed": True}
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
            values = (
                {"mode": "panic" if "Panic" in case else "drop", "policy": self.policy, "coverage": first},
                {"mode": "panic" if "Panic" in case else "drop", "panic_confirmed": "Panic" in case,
                    "observer_joined": True, "receiver_polled_pending": True,
                    "receiver_pending_ns": at(5), "observer_joined_ns": at(6),
                    "tracker_shutdown_pending": True, "accounting_shutdown_pending": True, "coverage": covered},
                {"pool_held_ns": at(8), "status_held_ns": at(9), "heartbeat_pending_ns": at(10),
                    "heartbeat_polled_pending": True, "observer": {"started_ns": at(10)+1,
                        "completed_ns": at(11), "available_bytes": 32*gib, "age_ns": 2,
                        "read_duration_ns": 1, "joined": True}, "coverage": covered},
                {"pool_released_ns": at(13), "status_held_ns": at(9),
                    "heartbeat": heartbeat(1,14,15,(2,4096)), "tracker_shutdown_pending": True,
                    "accounting_shutdown_pending": True, "coverage": covered},
                {"io_released_ns": at(17), "status_held_ns": at(9), "status_wait_polled_ns": at(21),
                    "status_waits_before": 0, "status_waits_after": 1, "tracker_shutdown_pending": True,
                    "accounting_joined": True, "heartbeat": heartbeat(2,23,24,(0,0)),
                    "accounting": accounts, "allocated": [0,0,0]},
                {"tracker_joined": True, "accounting_joined": True, "observer_joined": True,
                    "heartbeat_joined": True, "provider_joined": True, "peer_joined": True,
                    "remaining_activation_owners": 0, "remaining_finalizing_owners": 0,
                    "allocated": [0,0,0], "accounting": accounts},
            )
            for phase, value, clock in zip(loss.PHASES, values, (4,7,12,16,25,28)):
                self.witnesses.append({"version": 1, "case": case, "phase": phase,
                    "monotonic_ns": at(clock), "unix_ns": at(clock)+1000,
                    "sandbox_id": terminal[1]["sandbox_id"], "backing_generation": terminal[1]["backing_generation"],
                    "evidence": copy.deepcopy(value)})

    def write(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(s) for s in self.samples))
        (self.root/"stdout.log").write_text("\n".join(
            [report.PREFIX+json.dumps(e) for e in self.events]
            + [loss.PREFIX+json.dumps(e) for e in self.witnesses]))

    def validate(self):
        self.write()
        return loss.validate(self.root)

    def refused(self, changes):
        original = copy.deepcopy(self.witnesses)
        for change in changes:
            self.witnesses = copy.deepcopy(original)
            change()
            with self.assertRaises(ValueError):
                self.validate()

    def test_all_four_cases_keep_parent_and_measurement_limits(self):
        value = self.validate()
        self.assertEqual(set(value["cases"]), loss.CASES)
        self.assertTrue(value["native_cleanup_observer_loss_complete"])
        for key in ("memory_envelope_calibrated", "production_protection_proven", "bootstrap_provenance_verified"):
            self.assertIs(value[key], False)

    def test_real_cli_refuses_incomplete_or_truncated_original_evidence(self):
        self.write()
        command = [sys.executable, str(pathlib.Path(__file__).with_name("observer_loss_report.py")), str(self.root)]
        self.assertTrue(json.loads(subprocess.check_output(command))["native_cleanup_observer_loss_complete"])
        self.witnesses.pop()
        self.write()
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
        with (self.root/"stdout.log").open("a") as output:
            output.write("\n"+loss.PREFIX+'{"version":')
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_missing_duplicate_reordered_and_mixed_identity_are_refused(self):
        self.refused((lambda: self.witnesses.pop(2),
            lambda: self.witnesses.append(copy.deepcopy(self.witnesses[-1])),
            lambda: self.witnesses[1].update(phase="tail_blocked"),
            lambda: self.witnesses[2].update(sandbox_id=str(uuid.uuid4())),
            lambda: self.witnesses[3].update(backing_generation=str(uuid.uuid4())),
            lambda: self.witnesses[0].update(version=True),
            lambda: self.witnesses[0].update(extra="unbound")))

    def test_observer_loss_requires_actual_pending_and_expected_joined_panic(self):
        self.refused((lambda: self.witnesses[1]["evidence"].update(panic_confirmed=True),
            lambda: self.witnesses[13]["evidence"].update(panic_confirmed=False),
            lambda: self.witnesses[1]["evidence"].update(observer_joined=False),
            lambda: self.witnesses[1]["evidence"].update(receiver_polled_pending=False),
            lambda: self.witnesses[1]["evidence"].update(receiver_pending_ns=self.witnesses[1]["monotonic_ns"])))

    def test_every_held_phase_retains_exact_original_lease_and_unreleased_io(self):
        self.refused(tuple(lambda index=i, field=k, replacement=v: self.witnesses[index]["evidence"]["coverage"].update({field:replacement})
            for i in range(4) for k,v in (("allocated",[0,0,0]),
                ("original_lease_active",False),("io_release_withheld",False))))

    def test_physical_tail_cannot_settle_early_or_become_uncertain(self):
        self.refused(tuple(lambda field=k, replacement=v: self.witnesses[1]["evidence"]["coverage"]["accounting"].update({field:replacement})
            for k,v in (("cleanup_growth_bytes",0),("registered_operations",0),("started",0),
                ("tracked_tasks",0),("uncertain",1),("closed",False),("started",True))))

    def test_held_shutdown_requires_positive_pending_for_both_owners(self):
        self.refused(tuple(lambda index=i, field=k: self.witnesses[index]["evidence"].update({field:False})
            for i in (1,3) for k in ("tracker_shutdown_pending","accounting_shutdown_pending")))

    def test_observation_and_acknowledged_heartbeat_progress_inside_original_waits(self):
        self.refused((lambda: self.witnesses[2]["evidence"]["observer"].update(joined=False),
            lambda: self.witnesses[2]["evidence"].update(heartbeat_polled_pending=False),
            lambda: self.witnesses[3]["evidence"]["heartbeat"]["receipt"].update(acknowledgement_status=500),
            lambda: self.witnesses[4]["evidence"]["heartbeat"]["receipt"]["state"].update(snapshotSequence=1),
            lambda: self.witnesses[4]["evidence"]["heartbeat"]["receipt"]["state"].update(runnerId=str(uuid.uuid4())),
            lambda: self.witnesses[3]["evidence"].update(status_held_ns=1)))

    def test_final_status_wait_follows_complete_tail_and_retains_tracker(self):
        self.refused((lambda: self.witnesses[4]["evidence"].update(io_released_ns=1),
            lambda: self.witnesses[4]["evidence"].update(status_wait_polled_ns=self.events[4]["monotonic_ns"]),
            lambda: self.witnesses[4]["evidence"].update(status_waits_after=0),
            lambda: self.witnesses[4]["evidence"].update(tracker_shutdown_pending=False),
            lambda: self.witnesses[4]["evidence"]["accounting"].update(tracked_tasks=1)))

    def test_every_producer_and_original_lease_must_finish(self):
        self.refused(tuple(lambda field=k: self.witnesses[5]["evidence"].update({field:False})
            for k in ("tracker_joined","accounting_joined","observer_joined","heartbeat_joined","provider_joined","peer_joined")))

    def test_inherited_original_data_backing_and_tail_are_required(self):
        for index,field in ((2,"positive_owned_wait"),(4,"written_and_verified_bytes"),(5,"original_home_restored")):
            original = copy.deepcopy(self.events)
            self.events[index]["evidence"][field] = False
            with self.assertRaises(ValueError):
                self.validate()
            self.events = original

    def test_original_policy_and_preparation_record_are_required(self):
        self.collector["metadata"]["native_observer_loss_policy_json"] += " "
        with self.assertRaises(ValueError):
            self.validate()
        self.collector["metadata"]["native_observer_loss_policy_json"] = json.dumps(self.policy)
        (self.root/"snapshot-preparation.json").unlink()
        with self.assertRaises(ValueError):
            self.validate()


if __name__ == "__main__":
    unittest.main()
