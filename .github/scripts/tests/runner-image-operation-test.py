#!/usr/bin/env python3
"""Exercise the public image command with real processes/files and external fixtures."""

import contextlib
import fcntl
import hashlib
import json
import os
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent
COMMAND = SCRIPTS / "runner/runner-image-operation.py"
CLEANUP = SCRIPTS / "runner/cleanup-metal-resources.py"
FIXTURE = SCRIPTS / "tests/fixtures/runner-image-operation-command.py"


class ImageOperationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="image-operation-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "bin").mkdir()
        (self.root / "units").mkdir()
        (self.root / "runner").write_bytes(b"validated runner fixture")
        for name in ("ssh", "sudo", "systemctl"):
            (self.root / "bin" / name).symlink_to(FIXTURE)
        self.environment = dict(
            os.environ,
            PATH=str(self.root / "bin") + os.pathsep + os.environ["PATH"],
            TMPDIR=str(self.root),
            IMAGE_FIXTURE=str(self.root),
            JOB_REF="pr-123",
            HEAD_SHA="a" * 40,
            METAL_USER="ci",
            TARGET_TRIPLE="aarch64-unknown-linux-musl",
            PROFILE="vm0/default",
            EXPECTED_BINARY_INPUT_DIGEST="b" * 64,
            RUNNER_IMAGE_RUNNER_SHA256=hashlib.sha256(
                (self.root / "runner").read_bytes()
            ).hexdigest(),
            GITHUB_RUN_ID="1234",
            GITHUB_RUN_ATTEMPT="1",
            RUNNER_IMAGE_RUN_CREATED_AT="2026-10-01T00:00:00Z",
            R2_ACCESS_KEY_ID="fixture-access-key",
            R2_SECRET_ACCESS_KEY="fixture-secret-key",
        )
        self.addCleanup(self.retire_fixture)
        self.result = self.root / "result.json"

    def retire_fixture(self):
        for pid in self.records("detached-servers"):
            with contextlib.suppress(ProcessLookupError):
                os.killpg(pid, signal.SIGKILL)
        for path in (self.root / "units").glob("*.json"):
            with contextlib.suppress(ProcessLookupError):
                os.killpg(json.loads(path.read_text())["pid"], signal.SIGKILL)

    def invoke(self, action, *arguments, check=True, input_text=None):
        result = subprocess.run(
            ["python3", str(COMMAND), action, "dev-11", *arguments],
            env=self.environment,
            input=input_text,
            capture_output=True,
            text=True,
            timeout=45,
            check=False,
        )
        if check:
            self.assertEqual(
                result.returncode,
                0,
                result.stdout + result.stderr + str(self.records("errors")),
            )
        return result

    def records(self, name):
        path = self.root / (name + ".jsonl")
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def wait_for(self, predicate):
        deadline = time.monotonic() + 12
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail("process synchronization deadline exceeded")
            time.sleep(0.01)

    @contextlib.contextmanager
    def cleanup_session(self):
        with subprocess.Popen(
            [
                sys.executable,
                str(CLEANUP),
                "session",
                "123",
                "--root",
                str(self.root),
            ],
            env=self.environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        ) as cleanup:
            try:
                yield cleanup
                cleanup.stdin.write('{"operation":"release"}\n')
                cleanup.stdin.flush()
                self.assertEqual(self.cleanup_reply(cleanup), {"released": True})
                cleanup.stdin.close()
                self.assertEqual(cleanup.wait(timeout=5), 0, cleanup.stderr.read())
            finally:
                if cleanup.poll() is None:
                    cleanup.kill()
                    cleanup.wait(timeout=5)

    def cleanup_reply(self, cleanup):
        self.assertTrue(select.select([cleanup.stdout], [], [], 15)[0])
        line = cleanup.stdout.readline()
        if not line:
            self.fail(cleanup.stderr.read())
        return json.loads(line)

    def clean_namespace(self, cleanup):
        cleanup.stdin.write('{"operation":"cleanup","closedAt":{"123":"2026-10-02T00:00:00Z"}}\n')
        cleanup.stdin.flush()
        return self.cleanup_reply(cleanup)["results"]["123"]

    def claim_waiter_opened(self, lock):
        for pid in reversed(self.records("claim-servers")):
            descriptors = Path(f"/proc/{pid}/fd")
            with contextlib.suppress(FileNotFoundError, ProcessLookupError):
                if any(descriptor.resolve() == lock for descriptor in descriptors.iterdir()):
                    return True
        return False

    def test_running_image_excludes_cleanup_until_completion(self):
        process = self.start_blocked()
        lock = self.root / "var/lock/vm0-runner-lifecycle-pr-123.lock"
        with self.cleanup_session() as cleanup:
            # Synchronize on the actual lock contender opening the same file.
            def contender_opened():
                descriptors = Path(f"/proc/{cleanup.pid}/fd")
                return any(p.resolve() == lock for p in descriptors.iterdir() if p.exists())

            self.wait_for(contender_opened)
            self.assertFalse(select.select([cleanup.stdout], [], [], 0)[0])
            (self.root / "release").touch()
            output, error = process.communicate(timeout=15)
            self.assertEqual(process.returncode, 0, output + error)
            self.assertEqual(self.cleanup_reply(cleanup), {"ready": [123]})
            self.assertEqual(self.clean_namespace(cleanup)["outcome"], "cleaned")
        self.assertFalse((self.root / "var/lib/vm0-runner/bin/pr-123-image-1234").exists())
        self.result.unlink()
        retired = self.invoke("run", "build", str(self.result), check=False)
        self.assertNotEqual(retired.returncode, 0, retired.stdout + retired.stderr)
        self.assertFalse(self.result.exists())
        self.assert_one_build()

    def test_cleanup_retires_image_queued_behind_its_lifecycle_lock(self):
        self.invoke("claim")
        with self.cleanup_session() as cleanup:
            self.assertEqual(self.cleanup_reply(cleanup), {"ready": [123]})
            process = subprocess.Popen(
                ["python3", str(COMMAND), "run", "dev-11", "build", str(self.result)],
                env=self.environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            self.addCleanup(lambda: process.poll() is None and process.kill())
            self.wait_for(lambda: bool(list((self.root / "units").glob("*.json"))))
            # Production promotion and rollback enumerate this prefix on the
            # same host. Image execution must stay outside that selection.
            self.assertFalse(list((self.root / "units").glob("vm0-runner-*.service.json")))
            outcome = self.clean_namespace(cleanup)
            self.assertEqual(outcome["outcome"], "cleaned", outcome)
            self.assertEqual(outcome["units"], 1)
        output, error = process.communicate(timeout=15)
        self.assertNotEqual(process.returncode, 0, output + error)
        self.assertEqual(self.records("executions"), [])
        self.assertFalse((self.root / "var/lib/vm0-runner/bin/pr-123-image-1234").exists())

    def test_cleanup_fences_a_late_service_and_same_owner_reclaim(self):
        self.invoke("claim")
        self.environment["IMAGE_FAULT"] = "pending-launch"
        directory = self.root / "var/lib/vm0-runner/bin/pr-123-image-1234"
        command = f"from pathlib import Path; p=Path({str(directory)!r}); p.mkdir(parents=True); (p/'late').touch()"
        process = subprocess.Popen(
            ["python3", str(COMMAND), "guard", "dev-11", "python3", "-c", command],
            env=self.environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.addCleanup(lambda: process.poll() is None and process.kill())
        try:
            self.wait_for(lambda: (self.root / "launch-pending").exists())
            with self.cleanup_session() as cleanup:
                self.assertEqual(self.cleanup_reply(cleanup), {"ready": [123]})
                self.assertEqual(self.clean_namespace(cleanup)["outcome"], "cleaned")
        finally:
            (self.root / "release-launch").touch()
        output, error = process.communicate(timeout=15)
        self.assertNotEqual(process.returncode, 0, output + error)
        self.assertFalse(directory.exists(), "late admission must not recreate the namespace")
        self.environment.pop("IMAGE_FAULT")
        self.assertNotEqual(self.invoke("claim", check=False).returncode, 0)
        self.environment.update(
            GITHUB_RUN_ID="1235", RUNNER_IMAGE_RUN_CREATED_AT="2026-10-03T00:00:00Z"
        )
        self.invoke("claim")
        successor = directory.with_name("pr-123-image-1235")
        self.invoke("guard", "touch", str(successor / "successor"), input_text="")
        self.assertTrue((successor / "successor").exists())
        self.assertFalse(directory.exists())

    def test_uncommitted_claim_cannot_recreate_a_cleaned_namespace(self):
        self.environment["IMAGE_FAULT"] = "claim-commit-loss"
        self.assertNotEqual(self.invoke("claim", check=False).returncode, 0)
        with self.cleanup_session() as cleanup:
            self.assertEqual(self.cleanup_reply(cleanup), {"ready": [123]})
            self.assertEqual(self.clean_namespace(cleanup)["outcome"], "cleaned")
        self.assertNotEqual(self.invoke("claim", check=False).returncode, 0)
        self.assertFalse((self.root / "var/lib/vm0-runner/bin/pr-123-image-1234").exists())
        self.environment.update(
            GITHUB_RUN_ID="1235", RUNNER_IMAGE_RUN_CREATED_AT="2026-10-03T00:00:00Z"
        )
        self.invoke("claim")
        self.invoke("run", "build", str(self.result))
        self.assert_one_build()

    def test_claim_waiting_on_cleanup_cannot_recreate_namespace(self):
        self.invoke("claim")
        self.environment["GITHUB_RUN_ATTEMPT"] = "2"
        directory = self.root / "var/lib/vm0-runner/bin/pr-123-image-1234"
        with self.cleanup_session() as cleanup:
            self.assertEqual(self.cleanup_reply(cleanup), {"ready": [123]})
            claim = subprocess.Popen(
                ["python3", str(COMMAND), "claim", "dev-11"],
                env=self.environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            self.addCleanup(lambda: claim.poll() is None and claim.kill())
            lock = self.root / "var/lock/vm0-runner-lifecycle-pr-123.lock"
            self.wait_for(lambda: self.claim_waiter_opened(lock))
            self.assertEqual(self.clean_namespace(cleanup)["outcome"], "cleaned")
            self.assertFalse(directory.exists())
        out, error = claim.communicate(timeout=10)
        self.assertNotEqual(claim.returncode, 0, out + error)
        self.assertIn(b"image workflow predates PR closure", error)
        self.assertFalse(directory.with_name("pr-123-image-1235").exists())
        # A request first delivered after cleanup still carries its original
        # GitHub timestamp. Equal-second ordering cannot establish freshness.
        self.environment.update(
            GITHUB_RUN_ID="1235", RUNNER_IMAGE_RUN_CREATED_AT="2026-10-02T00:00:00Z"
        )
        self.assertNotEqual(self.invoke("claim", check=False).returncode, 0)
        self.assertFalse(directory.exists())
        self.environment.update(
            GITHUB_RUN_ID="1236", RUNNER_IMAGE_RUN_CREATED_AT="2026-10-03T00:00:00Z"
        )
        self.invoke("claim")
        self.assertTrue(directory.with_name("pr-123-image-1236").exists())

    def test_cancellation_can_fence_a_claim_waiting_for_preview(self):
        lock = self.root / "var/lock/vm0-runner-lifecycle-pr-123.lock"
        lock.parent.mkdir(parents=True)
        directory = self.root / "var/lib/vm0-runner/bin/pr-123-image-1234"
        with lock.open("a") as holder:
            fcntl.flock(holder, fcntl.LOCK_EX)
            claim = subprocess.Popen(
                [sys.executable, str(COMMAND), "claim", "dev-11"],
                env=self.environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            self.addCleanup(lambda: claim.poll() is None and claim.kill())
            self.wait_for(lambda: self.claim_waiter_opened(lock))
            self.assertFalse(directory.exists())
            self.invoke("cancel")
            self.assertFalse(directory.exists())
        output, error = claim.communicate(timeout=10)
        self.assertNotEqual(claim.returncode, 0, output + error)
        self.assertIn("cancelled", error)
        self.assertFalse(directory.exists())

    def test_claim_budget_includes_prior_worker_retirement(self):
        self.invoke("claim")
        self.invoke("run", "warm", str(self.result))
        self.environment.update(GITHUB_RUN_ID="1235", IMAGE_FAULT="slow-claim-retirement")
        outcome = self.invoke("claim", check=False)
        self.assertNotEqual(outcome.returncode, 0, outcome.stdout + outcome.stderr)
        self.assertIn("image claim work deadline exceeded", outcome.stderr)
        binary_root = self.root / "var/lib/vm0-runner/bin"
        self.assertTrue((binary_root / "pr-123-image-1234").is_dir())
        self.assertFalse((binary_root / "pr-123-image-1235").exists())

    def start_blocked(self, fault=""):
        self.environment["IMAGE_FAULT"] = fault
        self.invoke("claim")
        (self.root / "block").touch()
        process = subprocess.Popen(
            ["python3", str(COMMAND), "run", "dev-11", "build", str(self.result)],
            env=self.environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.addCleanup(lambda: process.poll() is None and process.kill())
        self.wait_for(lambda: bool(self.records("executions")))
        return process

    def test_successor_keeps_prior_image_until_closed_pr_cleanup(self):
        self.invoke("claim")
        binary_root = self.root / "var/lib/vm0-runner/bin"
        first = binary_root / "pr-123-image-1234"
        second = binary_root / "pr-123-image-1235"
        self.invoke("guard", "touch", str(first / "runner"), input_text="")
        self.environment["GITHUB_RUN_ID"] = "1235"
        self.invoke("claim")
        self.invoke("guard", "touch", str(second / "runner"), input_text="")
        self.assertTrue((first / "runner").is_file())
        self.assertTrue((second / "runner").is_file())
        with self.cleanup_session() as cleanup:
            self.assertEqual(self.cleanup_reply(cleanup), {"ready": [123]})
            self.assertEqual(self.clean_namespace(cleanup)["outcome"], "cleaned")
        self.assertFalse(first.exists())
        self.assertFalse(second.exists())

    def assert_one_build(self):
        self.assertEqual([r["phase"] for r in self.records("executions")], ["build"])

    def test_healthy_and_lost_result_keep_original_execution(self):
        for fault in ("", "lost-result", "partial-result"):
            with self.subTest(fault=fault):
                (self.root / "fault-used").unlink(missing_ok=True)
                self.environment["IMAGE_FAULT"] = fault
                self.environment["GITHUB_RUN_ATTEMPT"] = str(
                    int(self.environment["GITHUB_RUN_ATTEMPT"]) + 1
                )
                started = time.monotonic()
                self.invoke("claim")
                outcome = self.invoke("run", "build", str(self.result))
                result = json.loads(self.result.read_text())
                self.assertEqual(result["status"], 0)
                self.assertEqual(result["rootfsHash"], "1" * 64)
                self.assertEqual(result["snapshotHash"], "2" * 64)
                self.assertIn("image-progress", outcome.stdout)
                self.assertNotIn(self.environment["R2_SECRET_ACCESS_KEY"], outcome.stdout)
                request_count = sum(r["action"] == "run" for r in self.records("requests"))
                print(
                    f"image fixture fault={fault or 'none'} elapsed={time.monotonic() - started:.3f}s cumulative_run_requests={request_count}"
                )
        self.assertEqual(len(self.records("executions")), 3)
        self.assertEqual(sum(r["action"] == "run" for r in self.records("requests")), 5)
        calls = json.dumps(self.records("privileged"))
        self.assertNotIn(self.environment["R2_SECRET_ACCESS_KEY"], calls)
        self.assertIn("--property=RuntimeMaxSec=570", calls)
        self.assertIn("--on-active=1h", calls)
        for path in self.root.glob("vm0-runner-image-*/*/*/*"):
            if path.is_file():
                self.assertNotIn(
                    self.environment["R2_SECRET_ACCESS_KEY"].encode(),
                    path.read_bytes(),
                    str(path),
                )

    def test_lost_launch_reply_reattaches_without_replay(self):
        process = self.start_blocked("lost-launch")
        self.wait_for(lambda: sum(r["action"] == "run" for r in self.records("requests")) == 2)
        (self.root / "release").touch()
        output, error = process.communicate(timeout=15)
        self.assertEqual(process.returncode, 0, output + error)
        self.assert_one_build()
        self.assertEqual(json.loads(self.result.read_text())["status"], 0)

    def test_lost_reply_while_original_launch_is_still_submitting(self):
        self.environment["IMAGE_FAULT"] = "pending-launch"
        self.invoke("claim")
        (self.root / "block").touch()
        with (self.root / "client.log").open("w") as output:
            process = subprocess.Popen(
                ["python3", str(COMMAND), "run", "dev-11", "build", str(self.result)],
                env=self.environment,
                stdout=output,
                stderr=subprocess.PIPE,
                text=True,
            )
        self.addCleanup(lambda: process.poll() is None and process.kill())
        try:
            self.wait_for(lambda: (self.root / "observed-pending-launch").exists())
            (self.root / "release-launch").touch()
            self.wait_for(
                lambda: (
                    "image-progress" in (self.root / "client.log").read_text()
                    or process.poll() is not None
                )
            )
            self.assertIn(
                "image-progress",
                (self.root / "client.log").read_text(),
                "a missing unit while the original launch owns the gate is still pending",
            )
        finally:
            (self.root / "release-launch").touch()
            (self.root / "release").touch()
            _output, error = process.communicate(timeout=20)
        self.assertEqual(process.returncode, 0, error)
        self.assert_one_build()
        self.assertEqual(sum(r["action"] == "run" for r in self.records("requests")), 2)

    def test_failure_after_hash_output_stays_failure(self):
        self.environment["IMAGE_BUILD_STATUS"] = "23"
        self.environment["IMAGE_FAULT"] = "lost-result"
        self.invoke("claim")
        result = self.invoke("run", "build", str(self.result), check=False)
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertEqual(json.loads(self.result.read_text())["status"], 23)
        self.assert_one_build()

    def test_intent_published_while_reconnection_waits_for_gate(self):
        self.environment["IMAGE_FAULT"] = "contended-launch"
        self.invoke("claim")
        (self.root / "block").touch()
        gate = next(self.root.glob("vm0-runner-image-*/*/gate"))
        with gate.open("r+") as lock, (self.root / "client.log").open("w") as output:
            fcntl.flock(lock, fcntl.LOCK_EX)
            process = subprocess.Popen(
                ["python3", str(COMMAND), "run", "dev-11", "build", str(self.result)],
                env=self.environment,
                stdout=output,
                stderr=subprocess.PIPE,
                text=True,
            )
            self.addCleanup(lambda: process.poll() is None and process.kill())
            try:
                self.wait_for(lambda: (self.root / "observer-paused").exists())
                fcntl.flock(lock, fcntl.LOCK_UN)
                self.wait_for(lambda: bool(self.records("executions")))
                (self.root / "resume-observer").touch()
                self.wait_for(
                    lambda: (
                        "image-progress" in (self.root / "client.log").read_text()
                        or process.poll() is not None
                    )
                )
                self.assertIn(
                    "image-progress",
                    (self.root / "client.log").read_text(),
                    "reattachment must not wait for the original worker's mutation gate",
                )
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)
                (self.root / "resume-observer").touch()
                (self.root / "release").touch()
                _output, error = process.communicate(timeout=20)
        self.assertEqual(process.returncode, 0, error)
        self.assert_one_build()
        self.assertEqual(sum(r["action"] == "run" for r in self.records("requests")), 2)

    def test_invalid_results_fail_without_replay(self):
        for index, fault in enumerate(
            ("missing-hash", "invalid-hash", "wrong-result", "invalid-result-hash")
        ):
            with self.subTest(fault=fault):
                self.environment.update(IMAGE_FAULT=fault, GITHUB_RUN_ATTEMPT=str(index + 2))
                self.result.unlink(missing_ok=True)
                self.invoke("claim")
                result = self.invoke("run", "build", str(self.result), check=False)
                self.assertNotEqual(result.returncode, 0)
                if self.result.exists():
                    self.assertNotEqual(json.loads(self.result.read_text())["status"], 0)
        self.assertEqual(len(self.records("executions")), 4)

    def test_cancellation_retires_worker_and_preserves_lease_successor(self):
        process = self.start_blocked()
        self.assertTrue(
            select.select([process.stdout], [], [], 10)[0],
            "expected progress before completion",
        )
        self.assertIn("image-progress", process.stdout.readline())
        process.terminate()
        output, error = process.communicate(timeout=15)
        self.assertNotEqual(process.returncode, 0, output + error)
        self.assertFalse(self.result.exists())
        self.assertTrue(self.records("stops"))
        for record in self.records("executions"):
            # Reaping between the existence check and read also proves exit.
            with contextlib.suppress(FileNotFoundError, ProcessLookupError):
                self.wait_for(
                    lambda: (
                        not Path(f"/proc/{record['pid']}").exists()
                        or Path(f"/proc/{record['pid']}/stat")
                        .read_text()
                        .split(")", 1)[1]
                        .split()[0]
                        == "Z"
                    )
                )

    def test_new_owner_stops_old_work_and_old_owner_cannot_launch(self):
        process = self.start_blocked()
        self.environment["GITHUB_RUN_ID"] = "1235"
        self.invoke("claim")
        successor_result = self.root / "successor.json"
        successor = subprocess.Popen(
            ["python3", str(COMMAND), "run", "dev-11", "build", str(successor_result)],
            env=self.environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.addCleanup(lambda: successor.poll() is None and successor.kill())
        self.wait_for(lambda: len(self.records("executions")) == 2)
        output, error = process.communicate(timeout=15)
        self.assertNotEqual(process.returncode, 0, output + error)
        self.assertTrue(self.records("stops"))
        self.environment["GITHUB_RUN_ID"] = "1234"
        self.assertNotEqual(self.invoke("claim", check=False).returncode, 0)
        self.assertNotEqual(
            self.invoke("run", "build", str(self.result), check=False).returncode, 0
        )

        self.assertIsNone(successor.poll(), "old-owner cancellation must preserve the successor")
        (self.root / "release").touch()
        output, error = successor.communicate(timeout=15)
        self.assertEqual(successor.returncode, 0, output + error)
        self.assertEqual(json.loads(successor_result.read_text())["status"], 0)

    def test_cancelled_owner_cannot_deliver_an_inflight_result(self):
        process = self.start_blocked("pause-active-observation")
        try:
            self.wait_for(lambda: (self.root / "active-observation-paused").exists())
            (self.root / "release").touch()
            self.wait_for(lambda: any(self.root.glob("vm0-runner-image-*/*/*/result.json")))
            self.environment.pop("IMAGE_FAULT")
            self.invoke("cancel")
        finally:
            (self.root / "resume-active-observation").touch()
        output, error = process.communicate(timeout=15)
        self.assertNotEqual(process.returncode, 0, output + error)
        self.assertFalse(self.result.exists())
        self.assert_one_build()

    def test_failed_retirement_retains_old_work_and_blocks_namespace_reuse(self):
        process = self.start_blocked()
        self.environment.update(GITHUB_RUN_ID="1235", IMAGE_FAULT="failed-stop")
        self.assertNotEqual(self.invoke("claim", check=False).returncode, 0)
        self.assertIsNone(process.poll())
        self.assertTrue(any(self.root.glob("vm0-runner-image-*/*/*/intent.json")))
        operation = next(self.root.glob("vm0-runner-image-*/*/*/intent.json")).parent
        expiration = subprocess.run(
            ["python3", str(COMMAND), "expire", str(operation)],
            env=self.environment,
            capture_output=True,
            text=True,
            timeout=20,
        )
        self.assertNotEqual(expiration.returncode, 0)
        self.assertTrue(operation.exists(), "expiration must retain files when stop is unconfirmed")
        (self.root / "release").touch()
        output, error = process.communicate(timeout=15)
        self.assertEqual(process.returncode, 0, output + error)

    def test_ambiguous_launch_never_restarts_and_permanent_ssh_never_retries(self):
        self.invoke("claim")
        self.environment["IMAGE_FAULT"] = "absent-launch"
        self.assertNotEqual(
            self.invoke("run", "build", str(self.result), check=False).returncode, 0
        )
        self.environment["IMAGE_FAULT"] = ""
        self.assertNotEqual(
            self.invoke("run", "build", str(self.result), check=False).returncode, 0
        )
        self.assertFalse(self.records("executions"))
        self.environment["IMAGE_FAULT"] = "ssh-error"
        before = len(self.records("requests"))
        self.assertNotEqual(self.invoke("claim", check=False).returncode, 0)
        self.assertEqual(len(self.records("requests")) - before, 1)

    def test_changed_inputs_cannot_consume_existing_success(self):
        self.invoke("claim")
        self.invoke("run", "build", str(self.result))
        self.environment["HEAD_SHA"] = "c" * 40
        self.result.unlink()
        self.assertNotEqual(self.invoke("claim", check=False).returncode, 0)
        self.assertNotEqual(
            self.invoke("run", "build", str(self.result), check=False).returncode, 0
        )
        self.assertFalse(self.result.exists())
        self.assert_one_build()

    def test_expired_result_cannot_permit_execution_again(self):
        self.invoke("claim")
        self.invoke("run", "build", str(self.result))
        operation = next(self.root.glob("vm0-runner-image-*/*/*/intent.json")).parent
        timer = next(args for args in self.records("systemd") if "--on-active=1h" in args)
        self.assertIn(f"--uid={os.getuid()}", timer)
        self.assertIn(f"--gid={os.getgid()}", timer)
        expiration = subprocess.run(
            timer[timer.index("/bin/sh") :],
            env=self.environment,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        self.assertEqual(expiration.returncode, 0, expiration.stderr)
        self.assertFalse(operation.exists())
        self.result.unlink()
        self.invoke("claim")
        output = self.invoke("run", "build", str(self.result), check=False)
        self.assertNotEqual(output.returncode, 0)
        self.assertFalse(self.result.exists())
        self.assert_one_build()

    def test_lost_claim_is_idempotent_and_warm_needs_no_image_hash(self):
        self.environment["IMAGE_FAULT"] = "lost-claim"
        self.invoke("claim")
        self.assertEqual(sum(r["action"] == "claim" for r in self.records("requests")), 2)
        self.invoke("run", "warm", str(self.result))
        self.assertEqual(json.loads(self.result.read_text())["status"], 0)
        self.assertEqual([r["phase"] for r in self.records("executions")], ["warm"])

    def test_broken_request_pipe_recovers_before_submission(self):
        self.environment["IMAGE_FAULT"] = "early-eof"
        self.invoke("claim")
        self.assertEqual(self.records("requests")[0]["action"], "unread")
        self.invoke("run", "build", str(self.result))
        self.assert_one_build()

    def test_cancellation_fences_late_systemd_acceptance(self):
        self.invoke("claim")
        self.environment["IMAGE_FAULT"] = "absent-launch"
        self.assertNotEqual(
            self.invoke("run", "build", str(self.result), check=False).returncode, 0
        )
        operation = next(self.root.glob("vm0-runner-image-*/*/*/intent.json")).parent
        late = subprocess.run(
            ["python3", str(operation / "worker.py"), "worker", str(operation)],
            env=self.environment,
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertNotEqual(late.returncode, 0)
        self.assertIn("cancelled", late.stderr)
        self.assertFalse(self.records("executions"))
        self.assertNotEqual(self.invoke("claim", check=False).returncode, 0)

    def test_cancellation_before_first_claim_fences_that_generation(self):
        for existing_owner in (False, True):
            with self.subTest(existing_owner=existing_owner):
                old_run = 1234 + int(existing_owner) * 10
                cancelled_run = old_run + 1
                self.environment["GITHUB_RUN_ID"] = str(old_run)
                if existing_owner:
                    self.invoke("claim")
                self.environment["GITHUB_RUN_ID"] = str(cancelled_run)
                self.invoke("cancel")
                late = self.invoke("claim", check=False)
                self.assertNotEqual(late.returncode, 0, late.stderr)
                self.assertFalse(
                    (self.root / f"var/lib/vm0-runner/bin/pr-123-image-{cancelled_run}").exists()
                )
                if existing_owner:
                    self.environment["GITHUB_RUN_ID"] = str(old_run)
                    self.invoke("guard", "true", input_text="")
                self.environment["GITHUB_RUN_ID"] = str(cancelled_run + 1)
                self.invoke("claim")

    def test_runner_bytes_are_rechecked_before_execution(self):
        self.environment["RUNNER_IMAGE_RUNNER_SHA256"] = "0" * 64
        self.invoke("claim")
        self.assertNotEqual(
            self.invoke("run", "build", str(self.result), check=False).returncode, 0
        )
        self.assertFalse(self.records("executions"))

    def test_unavailable_state_root_does_not_fall_back_to_disk(self):
        fallback = self.root / "fallback"
        fallback.mkdir()
        self.environment.update(IMAGE_FAULT="missing-state-root", TEMP=str(fallback))
        outcome = self.invoke("claim", check=False)
        self.assertNotEqual(outcome.returncode, 0)
        self.assertFalse(
            list(fallback.iterdir()),
            "unavailable tmpfs must not create disk-backed state",
        )

    def test_inactive_unit_with_populated_cgroup_is_not_retired(self):
        events = Path("/sys/fs/cgroup/cgroup.events")
        if events.exists() and "populated 0" in events.read_text():
            self.skipTest("fixture parent has no populated cgroup")
        self.invoke("claim")
        self.invoke("run", "build", str(self.result))
        self.environment.update(IMAGE_FAULT="populated-cgroup", GITHUB_RUN_ID="1235")
        self.assertNotEqual(self.invoke("claim", check=False).returncode, 0)
        self.assertTrue(any(self.root.glob("vm0-runner-image-*/*/*/result.json")))

    def test_capped_log_keeps_late_hashes_and_redacts_chunk_boundaries(self):
        self.environment["IMAGE_FAULT"] = "large-log"
        self.invoke("claim")
        result = self.invoke("run", "build", str(self.result))
        self.assertTrue(json.loads(self.result.read_text())["logTruncated"])
        self.assertNotIn(self.environment["R2_SECRET_ACCESS_KEY"], result.stdout)
        log = next(self.root.glob("vm0-runner-image-*/*/*/output.log"))
        self.assertEqual(log.stat().st_size, 1024 * 1024)
        self.assertNotIn(self.environment["R2_SECRET_ACCESS_KEY"].encode(), log.read_bytes())

    def test_guarded_preparation_is_fenced_and_does_not_replay(self):
        self.invoke("claim")
        output = self.invoke("guard", "bash", "-s", input_text="printf prepared")
        self.assertEqual(output.stdout, "prepared")
        self.environment["HEAD_SHA"] = "c" * 40
        output = self.invoke(
            "guard",
            "bash",
            "-s",
            check=False,
            input_text="echo unsafe > '" + str(self.root / "unsafe") + "'",
        )
        self.assertNotEqual(output.returncode, 0)
        self.assertFalse((self.root / "unsafe").exists())

    def test_lost_preparation_reply_does_not_repeat_mutation(self):
        self.invoke("claim")
        self.environment["IMAGE_FAULT"] = "lost-guard"
        marker = self.root / "mutations"
        output = self.invoke(
            "guard",
            "bash",
            "-s",
            check=False,
            input_text="echo prepared >> '" + str(marker) + "'",
        )
        self.assertEqual(output.returncode, 0, output.stderr)
        self.assertEqual(marker.read_text().splitlines(), ["prepared"])


if __name__ == "__main__":
    unittest.main()
