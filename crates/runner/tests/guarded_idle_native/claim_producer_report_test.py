#!/usr/bin/env python3
"""Synthetic real ext4/log/CLI contracts; no native execution is claimed."""
import copy
import hashlib
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

import claim_loss_report_test as c7_test
import claim_producer_report as producer
import cleanup_report as cleanup
import report


class ClaimProducerReportTests(unittest.TestCase):
    def setUp(self):
        c7_test.ClaimLossReportTests.setUp(self)
        raw = self.collector["metadata"].pop("native_claim_loss_policy_json")
        self.collector["metadata"]["native_claim_producer_policy_json"] = raw
        self.collector.update(success=False, driver_exit_code=101, cleanup_intervened=True)
        template, heartbeat = copy.deepcopy(self.events[0]), copy.deepcopy(self.witnesses[2]["evidence"]["heartbeat"])
        sample = copy.deepcopy(self.samples[0])
        self.case = "ClaimProducerLost-observed-fresh"
        self.ident, self.backing, self.history, self.run, self.runner, attempt, attempt_sandbox = [str(uuid.uuid4()) for _ in range(7)]
        self.payload = (self.history.encode()*2000)[:65536]
        at = lambda value: 10_000_000_000+value*1_000_000
        # home.ext4 is mounted at /home/user in the Guest. Its filesystem root
        # contains the home contents, without that mount-point prefix.
        seed = self.root/"seed"
        private = seed/".vm0"/"guest-agent"/"runs"/self.history
        private.mkdir(parents=True)
        (private/"fixture-private").write_bytes(b"fixture private bytes")
        (seed/"guarded-idle-ordinary").write_bytes(b"native ordinary home bytes")
        (seed/"guarded-idle-payload").write_bytes(self.payload)
        image = self.root/"retained-home.ext4"
        with image.open("wb") as stream:
            stream.truncate(report.NATIVE_HOME_BYTES)
        subprocess.run(["/usr/sbin/mke2fs", "-q", "-F", "-t", "ext4", "-O", "^has_journal",
                        "-d", str(self.root/"seed"), str(image)], check=True, capture_output=True)
        with image.open("rb") as stream:
            stream.seek(1024)
            block = stream.read(1024)
        home = {"path": f"/var/tmp/native-case/workspaces/{self.ident}/home.ext4",
                "bytes": image.stat().st_size, "filesystem_uuid": block[104:120].hex(),
                "superblock_sha256": hashlib.sha256(block).hexdigest()}
        accepted = {"run_id": self.run, "history_run_id": self.history,
                    "reuse_key": "thread:native-guarded-"+self.history, "profile": "vm0/default",
                    "accepted_ns": at(3), "boundary": "JobProvider::claim", "accepted_calls": 1}
        heartbeat["receipt"].update(received_ns=at(13))
        heartbeat["receipt"]["state"].update(runnerId=self.runner, heldSandboxStates=[])
        heartbeat["completed_ns"] = at(13)+1
        status = {"mode": "starting", "max_concurrent": 1, "active_runs": [],
                  "started_at": "2026-10-19T01:00:00Z", "updated_at": "2026-10-19T01:00:01Z"}
        self.values = [
            {"history_run_id": self.history, "payload_sha256": hashlib.sha256(self.payload).hexdigest(),
             "payload_bytes": 65536, "original_private_and_home_verified": True, "guest_sync_completed": True},
            {"policy": self.policy, "history_run_id": self.history, "claim_run_id": self.run,
             "reuse_key": "thread:native-guarded-"+self.history, "producer": accepted,
             "restore": {"sandbox_id": self.ident, "backing_generation": self.backing,
                         "completed_ns": at(4), "actual_restore_rpc_completed": True},
             "preparation_polled_pending": True, "original_full_lease_active": True,
             "original_exit_polled_pending": True, "allocated": [2,4096,1]},
            {"pool_held_ns": at(6), "heartbeat_pending_ns": at(7),
             "observer": {"started_ns": at(8), "completed_ns": at(9), "available_bytes": 32*1024**3,
                          "age_ns": 2, "read_duration_ns": 1, "joined": True},
             "pool_released_ns": at(12), "heartbeat": heartbeat, "producer_still_held": True,
             "original_full_lease_active": True, "allocated": [2,4096,1],
             "sample_after_ns": at(13)+2, "p1_sample_ns": at(14)},
            {"cancelled": False, "response_observer_cancelled_ns": None, "release_requested_ns": at(18),
             "joined_ns": at(24), "producer": accepted | {"unwind_ns": at(20)}, "tracker_joined": True,
             "actual_native_restore_completed": True, "original_full_lease_active": True, "allocated": [2,4096,1]},
            {"first_receipt": "ProducerLost", "second_receipt": "Consumed", "later_wait": "ProducerLost",
             "commit_refused": True, "rollback_refused": True, "required_cleanup_conversion_still_refused": True,
             "pool_empty": True, "promotion_lock_busy": True, "promotion_probe_run_id": attempt,
             "promotion_probe_sandbox_id": attempt_sandbox, "original_home": home, "published_status": status,
             "original_full_lease_active": True, "original_exit_polled_pending": True, "allocated": [2,4096,1],
             "returned_completion_authorizations": 0, "completion_reports": 0,
             "required_saving_complete": False, "cleanup_complete": False},
            {"claim_producer_joined": True, "tracker_joined": True, "accounting_joined": True,
             "heartbeat_joined": True, "heartbeat_provider_joined": True, "peer_joined": True,
             "admission_retained": True, "backing_wait_retained_pending": True, "original_full_lease_active": True,
             "allocated": [2,4096,1], "accounting": dict.fromkeys(cleanup.COUNTS, 0) | {"closed": True},
             "original_home": home, "original_outcome": "ProducerLost", "required_saving_complete": False,
             "cleanup_complete": False, "physical_relief_proven": False, "memory_credit": False},
        ]
        def event(phase, when, value):
            result = copy.deepcopy(template)
            result.update(case=self.case, phase=phase, monotonic_ns=at(when), unix_ns=at(when)+1000,
                          sandbox_id=self.ident, backing_generation=self.backing, evidence=value)
            return result
        self.events = [event("case_started", 0, {"artifacts": self.artifacts}), event("terminal_started", 2, {})]
        self.events[0].update(sandbox_id=None, backing_generation=None)
        self.witnesses = [event(phase, when, value) for phase, when, value in
                          zip(producer.PHASES, (1,5,15,25,30,35), self.values)]
        self.samples = []
        for when in (3,6,14,16,26,34):
            reading = copy.deepcopy(sample)
            reading["monotonic_ns"] = at(when)
            reading["processes"][0]["observed_monotonic_ns"] = at(when)
            self.samples.append(reading)

    def write(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(v) for v in self.samples))
        (self.root/"stdout.log").write_text("\n".join([report.PREFIX+json.dumps(v) for v in self.events]
            + [producer.PREFIX+json.dumps(v) for v in self.witnesses])+"\ntest result: FAILED\n")
        (self.root/"stderr.log").write_text("Error: ProducerLost\n")

    def validate(self):
        self.write()
        return producer.validate(self.root)

    def test_all_observer_and_native_mode_labels_preserve_failed_result(self):
        for case in sorted(producer.CASES):
            with self.subTest(case=case):
                for event in [*self.events, *self.witnesses]:
                    event["case"] = case
                joined = self.witnesses[3]["evidence"]
                joined["cancelled"] = "-cancelled-" in case
                joined["response_observer_cancelled_ns"] = joined["release_requested_ns"]-1 if joined["cancelled"] else None
                result = self.validate()
                self.assertTrue(result["native_producer_loss_custody_observed"])
                self.assertTrue(result["retained_original_data_verified"])
                self.assertEqual(result["original_driver_exit_code"], 101)
                for field in ("original_collector_success", "required_saving_complete", "cleanup_complete",
                              "physical_relief_proven", "memory_credit", "production_protection_proven"):
                    self.assertIs(result[field], False)

    def test_unavailable_cleared_uncertainty_reuse_credit_and_auth_are_refused(self):
        original = copy.deepcopy(self.witnesses)
        changes = [lambda v: v[1]["evidence"]["producer"].update(boundary="ApiProvider::None"),
                   lambda v: v[1]["evidence"]["restore"].update(actual_restore_rpc_completed=False),
                   lambda v: v[3]["evidence"].update(tracker_joined=False),
                   lambda v: v[4]["evidence"].update(later_wait="Rejected"),
                   lambda v: v[4]["evidence"].update(allocated=[0,0,0]),
                   lambda v: v[4]["evidence"].update(promotion_lock_busy=False),
                   lambda v: v[4]["evidence"].update(returned_completion_authorizations=1),
                   lambda v: v[5]["evidence"].update(required_saving_complete=True),
                   lambda v: v[5]["evidence"].update(memory_credit=True)]
        for index, change in enumerate(changes):
            with self.subTest(change=index):
                self.witnesses = copy.deepcopy(original)
                change(self.witnesses)
                with self.assertRaises(ValueError): self.validate()

    def test_successful_or_intervened_collector_cannot_become_cleanup_proof(self):
        original = copy.deepcopy(self.collector)
        for changes in ({"success": True}, {"driver_exit_code": 0}, {"headroom_stop": True},
                        {"driver_exit_code": True}, {"errors": ["teardown error"]}):
            with self.subTest(changes=changes):
                self.collector = copy.deepcopy(original) | changes
                with self.assertRaises(ValueError): self.validate()

    def test_phase_identity_clock_and_source_replay_are_refused(self):
        original = copy.deepcopy(self.witnesses)
        for change in (lambda v: v.pop(), lambda v: v.insert(1, copy.deepcopy(v[0])),
                       lambda v: v[1].update(backing_generation=str(uuid.uuid4())),
                       lambda v: v[1].update(monotonic_ns=1),
                       lambda v: v[3]["evidence"].update(response_observer_cancelled_ns=1)):
            self.witnesses = copy.deepcopy(original)
            change(self.witnesses)
            with self.assertRaises(ValueError): self.validate()

    def test_cli_requires_preserved_original_image_and_failed_logs(self):
        self.write()
        command = [sys.executable, str(pathlib.Path(__file__).with_name("claim_producer_report.py")), str(self.root)]
        self.assertEqual(subprocess.run(command, capture_output=True).returncode, 0)
        image = self.root/"retained-home.ext4"
        image.rename(self.root/"original.ext4")
        image.symlink_to(self.root/"original.ext4")
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_original_required_data_and_original_superblock_are_read(self):
        with (self.root/"retained-home.ext4").open("r+b") as image:
            image.seek(1024+104)
            image.write(b"changed-identity!")
        with self.assertRaises(ValueError): self.validate()

    def test_missing_required_payload_in_real_home_layout_is_rejected(self):
        subprocess.run(["/usr/sbin/debugfs", "-w", "-R", "rm /guarded-idle-payload",
                        str(self.root/"retained-home.ext4")], check=True, capture_output=True)
        with (self.root/"retained-home.ext4").open("rb") as image:
            image.seek(1024)
            digest = hashlib.sha256(image.read(1024)).hexdigest()
        for witness in self.witnesses[4:]:
            witness["evidence"]["original_home"]["superblock_sha256"] = digest
        with self.assertRaisesRegex(ValueError, "original retained native required bytes were lost"):
            self.validate()

    def test_acknowledged_sample_must_be_present_in_original_p1_files(self):
        self.samples = [sample for sample in self.samples
                        if sample["monotonic_ns"] != self.values[2]["p1_sample_ns"]]
        with self.assertRaisesRegex(ValueError, "acknowledged original P1 sample"):
            self.validate()


if __name__ == "__main__":
    unittest.main()
