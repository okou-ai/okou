#!/usr/bin/env python3
"""Synthetic original-file/CLI negatives; these are not native execution proof."""

import copy
import hashlib
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

import cleanup_report as cleanup
import real_api_claim_report as claim
import report
import report_test
import status_failure_report_test as baseline


class RealApiClaimReportTests(unittest.TestCase):
    def setUp(self):
        baseline.StatusFailureReportTests.setUp(self)
        self.orders = {}
        self.producer = {"format": "native-real-api-producer-v1", "source_sha": self.artifacts["source_sha"],
            "source_manifest_sha256": "f"*64, "source_archive_sha256": "e"*64,
            "guest_build_receipt_sha256": "d"*64, "rootfs_build_receipt_sha256": "c"*64,
            "node_sha256": "b"*64, "artifacts": copy.deepcopy(self.artifacts),
            "binaries": {name: {"path": "/synthetic/"+name, "sha256": self.artifacts[key]}
                         for name, key in (("host", "test_binary_sha256"), ("firecracker", "firecracker_sha256"),
                                           ("kernel", "kernel_sha256"), ("rootfs", "rootfs_sha256"))},
            "postgres": {"host": "127.0.0.1", "port": 55467, "version": "PostgreSQL synthetic",
                "system_identifier": "12345", "data_directory": "/synthetic/pgdata",
                "binary_sha256": "a"*64, "control_sha256": "9"*64, "migration_receipt_sha256": "8"*64,
                "migration_completed": True, "invocation_owned": True}}
        producer_raw = json.dumps(self.producer).encode()
        (self.root/"producer.json").write_bytes(producer_raw)
        producer_sha = hashlib.sha256(producer_raw).hexdigest()
        self.collector["metadata"]["native_real_api_producer_sha256"] = producer_sha
        template, sample = self.events[:6], self.samples[0]
        raw = self.collector["metadata"].pop("native_status_failure_policy_json")
        self.collector["metadata"]["native_real_api_policy_json"] = raw
        for order in claim.ORDERS:
            directory = self.root / order
            (directory / "p1").mkdir(parents=True)
            report_test.prepare_snapshot_record(directory / "p1", self.artifacts)
            inputs = {"source_sha": self.artifacts["source_sha"], "order": order,
                      "token": "synthetic-owner-only-token", "cases": {}}
            api = {"source_sha": inputs["source_sha"], "apiJoined": True,
                   "claims": [], "publicObservations": [], "producerSha256": producer_sha}
            events, witnesses, samples = [], [], []
            for index, mode in enumerate(claim.MODES):
                run, original, a, b = [str(uuid.uuid4()) for _ in range(4)]
                reuse = "thread:" + original
                inputs["cases"][mode] = {"claim_run_id": run, "original_run_id": original,
                    "runner_ids": [a, b], "reuse_key": reuse, "predecessor_context": {"runId": original}}
                winner = b if order == "b" else a
                api["publicObservations"].append({"runId": run, "runner": {"runnerId": winner},
                    "run": {"status": "completed"}, "laterClaimStatus": 404,
                    "laterPollStatus": 200, "laterPollBody": {"job": None},
                    "claimedPollStatus": 200, "claimedPollBody": {"job": None},
                    "laterClaimBody": {"error": {"code": "NOT_FOUND", "message": "Job not found in queue"}}})
                for role, runner in zip(("a", "b"), (a, b)):
                    at = lambda n: 10_000_000_000 * (index + 1) + int(n * 1_000_000) + (100 if role == "b" else 0)
                    sandbox, backing, peer = [str(uuid.uuid4()) for _ in range(3)]
                    terminal = copy.deepcopy(template)
                    for event, offset in zip(terminal, (0, 1, 30, 31, 45, 80)):
                        event.update(case=f"RealClaim-{order}-{role}-{mode}", sandbox_id=sandbox,
                            backing_generation=backing, monotonic_ns=at(offset), unix_ns=at(offset)+1000)
                        reading = copy.deepcopy(sample)
                        reading["monotonic_ns"] = at(offset)+1
                        reading["processes"][0]["observed_monotonic_ns"] = at(offset)+1
                        samples.append(reading)
                    events.extend(terminal)
                    won = runner == winner
                    authority = "synthetic-completion-authority-" + run
                    api["claims"].append({"runId": run, "runnerId": runner,
                        "path": f"/api/runners/jobs/{run}/claim", "authorization": "Bearer " + inputs["token"],
                        "body": {"runnerIdentity": {"runnerId": runner, "heartbeatGeneration": 1}},
                        "enteredNs": str(at(2)), "forwardedNs": str(at(12 if won or order == "both" else 19)),
                        "completedNs": str(at(18 if won else 19.5)), "status": 200 if won else 404,
                        "running": {"status": "running", "startedAt": "2026-10-19T01:00:00Z"} if won else None,
                        "runningObservedNs": str(at(17)) if won else None,
                        "response": {"runId": run, "reuseKey": reuse, "sandboxToken": authority} if won else
                            {"error": {"code": "NOT_FOUND", "message": "Run not found"}}})
                    def heartbeat(sequence, begin, end, allocated):
                        return {"receipt": {"received_ns": at(begin), "acknowledgement_status": 204,
                            "state": {"runnerId": peer, "snapshotGeneration": 1, "snapshotSequence": sequence,
                                "group": "native-foreground", "mode": "running", "allocatedVcpu": allocated[0],
                                "allocatedMemoryMb": allocated[1]}}, "send_joined": True, "completed_ns": at(end)}
                    observer = lambda a, b: {"started_ns": at(a), "completed_ns": at(b),
                        "available_bytes": 32*1024**3, "age_ns": 2, "read_duration_ns": 1, "joined": True}
                    status = {"mode": "starting", "max_concurrent": 1, "active_runs": [],
                        "started_at": "2026-10-19T01:00:00Z", "updated_at": "2026-10-19T01:00:02Z",
                        "idle_sandboxes": [{"reuse_key": reuse, "sandbox_id": sandbox}]}
                    empty = {k: v for k, v in status.items() if k != "idle_sandboxes"}
                    zero = dict.fromkeys(cleanup.COUNTS, 0) | {"closed": False}
                    active = zero | {"registered_operations": 1, "started": 1, "tracked_tasks": 1,
                                     "cleanup_growth_bytes": self.policy["tail_growth_bytes"]}
                    coverage = {"allocated": [2, 4096, 1], "accounting": active,
                                "original_lease_active": True, "io_release_withheld": True}
                    identity = {"runnerId": runner, "heartbeatGeneration": 1}
                    marker = {"run_id": run, "runner_id": runner, "role": role, "source_sha": inputs["source_sha"]}
                    outcome = {"allocated": [2, 4096, 1], "original_full_lease_active": True, "runner_identity": identity}
                    outcome.update({"marker": marker, "returned_run_id": run, "returned_reuse_key": reuse,
                        "completion_authority_sha256": hashlib.sha256(authority.encode()).hexdigest()} if won else
                        {"run_id": run, "published_status": status, "revision": 3})
                    values = [
                        {"run_id": run, "original_run_id": original, "runner_identity": identity,
                         "role": role, "order": order, "allocated": [2, 4096, 1],
                         "original_full_lease_active": True, "preparation_polled_pending": True,
                         "pool_held_ns": at(2), "heartbeat_pending_ns": at(2.5), "pool_released_ns": at(4.5),
                         "heartbeat_polled_pending": True,
                         "observer": observer(3, 4), "heartbeat": heartbeat(1, 5, 6, (2, 4096))}, outcome,
                        {"coverage": coverage, "original_exit_confirmed": True, "receiver_polled_pending": True},
                        {"coverage": coverage, "observer": observer(35, 36), "heartbeat": heartbeat(2, 37, 38, (2, 4096))},
                        {"status_held_ns": at(41), "io_released_ns": at(42), "status_wait_polled_ns": at(47),
                         "status_waits_before": 0, "status_waits_after": 1, "original_lease_released": True,
                         "receiver_polled_pending": True, "allocated": [0, 0, 0], "accounting": zero,
                         "heartbeat": heartbeat(3, 48, 49, (0, 0))},
                        {"status_released_ns": at(56), "batch_joined_ns": at(57), "published_status": empty,
                         "selected": 1, "completed": 1, "uncertain": 0, "not_started": 0, "status_error": False,
                         "is_complete": True, "regular_file": True, "allocated": [0, 0, 0]},
                        {"run_id": run, "role": role, "claim_joined": True, "provider_joined": True,
                         "heartbeat_joined": True, "saving_joined": True, "allocated": [0, 0, 0],
                         "accounting": zero | {"closed": True}},
                        {"run_id": run, "role": role, "won": won, "marker": marker if won else None,
                         "original_data_verified": True},
                    ]
                    phases = ("claim_wait_progress", "winner_executed" if won else "loser_restored", "tail_blocked",
                              "tail_wait_progress", "status_wait_progress", "original_completed", "producers_joined", "saved_task_verified")
                    for phase, value, offset in zip(phases, values, (10, 20, 34, 40, 55, 60, 70, 75)):
                        witnesses.append({"version": 1, "case": terminal[0]["case"], "phase": phase,
                            "monotonic_ns": at(offset), "unix_ns": at(offset)+1000, "sandbox_id": sandbox,
                            "backing_generation": backing, "evidence": copy.deepcopy(value)})
            self.orders[order] = (inputs, api, events, witnesses, sorted(samples, key=lambda e: e["monotonic_ns"]))

    def write(self):
        for order, (inputs, api, events, witnesses, samples) in self.orders.items():
            root = self.root / order
            for name, value in (("api-inputs.json", inputs), ("api-receipts.json", api), ("p1/report.json", self.collector)):
                (root/name).write_text(json.dumps(value))
            (root/"p1/samples.jsonl").write_text("\n".join(json.dumps(s) for s in samples))
            (root/"p1/stdout.log").write_text("\n".join([report.PREFIX+json.dumps(e) for e in events]
                + [claim.PREFIX+json.dumps(e) for e in witnesses]))

    def validate(self):
        self.write()
        return claim.validate(self.root)

    def test_complete_original_files_and_cli(self):
        result = self.validate()
        self.assertEqual(result["scenarios"], 6)
        self.assertEqual(result["independent_native_owner_paths"], 12)
        command = [sys.executable, str(pathlib.Path(__file__).with_name("real_api_claim_report.py")), str(self.root)]
        self.assertEqual(subprocess.run(command, capture_output=True).returncode, 0)
        self.orders["a"][3].pop()
        self.write()
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_incomplete_claims_authority_ownership_and_cleanup_are_refused(self):
        original = copy.deepcopy(self.orders)
        changes = [
            lambda i, a, e, w, s: a["claims"].pop(),
            lambda i, a, e, w, s: a["claims"][1].update(status=200),
            lambda i, a, e, w, s: a["claims"][1].update(status=500),
            lambda i, a, e, w, s: a["claims"][0].update(authorization="fabricated"),
            lambda i, a, e, w, s: a["claims"][0].update(runId=str(uuid.uuid4())),
            lambda i, a, e, w, s: a.update(apiJoined=False),
            lambda i, a, e, w, s: a["publicObservations"].clear(),
            lambda i, a, e, w, s: a["publicObservations"][0].update(laterPollBody={"job": {"runId": i["cases"]["fresh"]["claim_run_id"]}}),
            lambda i, a, e, w, s: a["publicObservations"][0].update(laterPollStatus=500),
            lambda i, a, e, w, s: a["publicObservations"][0].update(claimedPollBody={"job": {"runId": i["cases"]["fresh"]["claim_run_id"]}}),
            lambda i, a, e, w, s: w.pop(),
            lambda i, a, e, w, s: w.insert(0, copy.deepcopy(w[0])),
            lambda i, a, e, w, s: w[1]["evidence"].update(completion_authority_sha256="0"*64),
            lambda i, a, e, w, s: w[0]["evidence"].update(allocated=[0, 0, 0]),
            lambda i, a, e, w, s: w[6]["evidence"].update(provider_joined=False),
            lambda i, a, e, w, s: w[7]["evidence"].update(original_data_verified=False),
            lambda i, a, e, w, s: e[-1]["evidence"].update(original_home_restored=False),
            lambda i, a, e, w, s: i.update(source_sha="0"*40),
            lambda i, a, e, w, s: a.update(producerSha256="0"*64),
            lambda i, a, e, w, s: w[15]["evidence"].update(won=True),
            lambda i, a, e, w, s: a["claims"][0].update(completedNs=a["claims"][1]["forwardedNs"]),
            lambda i, a, e, w, s: a["claims"][0].update(running={"status": "pending"}),
            lambda i, a, e, w, s: w[0]["evidence"].update(heartbeat_polled_pending=False),
        ]
        for index, change in enumerate(changes):
            with self.subTest(change=index):
                self.orders = copy.deepcopy(original)
                change(*self.orders["a"])
                with self.assertRaises((ValueError, KeyError)):
                    self.validate()
        self.orders = original
        self.validate()

    def test_consistently_bound_but_wrong_producer_inputs_are_refused(self):
        original = copy.deepcopy(self.producer)
        changes = [
            lambda p: p["artifacts"].update(rootfs_sha256="0"*64),
            lambda p: p["binaries"]["host"].update(sha256="0"*64),
            lambda p: p["binaries"]["kernel"].update(path="relative/kernel"),
            lambda p: p["postgres"].update(migration_receipt_sha256="missing"),
            lambda p: p.update(guest_build_receipt_sha256="g"*64),
        ]
        for change in changes:
            producer = copy.deepcopy(original)
            change(producer)
            raw = json.dumps(producer).encode()
            (self.root/"producer.json").write_bytes(raw)
            sha = hashlib.sha256(raw).hexdigest()
            self.collector["metadata"]["native_real_api_producer_sha256"] = sha
            for inputs, api, events, witnesses, samples in self.orders.values():
                api["producerSha256"] = sha
            with self.assertRaises(ValueError):
                self.validate()
        raw = json.dumps(original).encode()
        (self.root/"producer.json").write_bytes(raw)
        sha = hashlib.sha256(raw).hexdigest()
        self.collector["metadata"]["native_real_api_producer_sha256"] = sha
        for inputs, api, events, witnesses, samples in self.orders.values():
            api["producerSha256"] = sha
        self.validate()


if __name__ == "__main__":
    unittest.main()
