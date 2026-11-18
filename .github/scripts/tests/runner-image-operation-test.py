#!/usr/bin/env python3
"""Exercise the public image command with real processes/files and external fixtures."""

import contextlib
import hashlib
import json
import os
import select
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent
COMMAND = SCRIPTS / "runner/runner-image-operation.py"
FIXTURE = SCRIPTS / "tests/fixtures/runner-image-operation-command.py"


class ImageOperationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="image-operation-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "bin").mkdir()
        (self.root / "units").mkdir()
        (self.root / "runner").write_bytes(b"validated runner fixture")
        for name in ("ssh", "sudo"):
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
                result.returncode, 0, result.stdout + result.stderr + str(self.records("errors"))
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
                    self.environment["R2_SECRET_ACCESS_KEY"].encode(), path.read_bytes(), str(path)
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
                lambda: "image-progress" in (self.root / "client.log").read_text()
                or process.poll() is not None
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
            select.select([process.stdout], [], [], 10)[0], "expected progress before completion"
        )
        self.assertIn("image-progress", process.stdout.readline())
        process.terminate()
        output, error = process.communicate(timeout=15)
        self.assertNotEqual(process.returncode, 0, output + error)
        self.assertFalse(self.result.exists())
        self.assertTrue(self.records("stops"))
        for record in self.records("executions"):
            self.wait_for(
                lambda: not Path(f"/proc/{record['pid']}").exists()
                or Path(f"/proc/{record['pid']}/stat").read_text().split(")", 1)[1].split()[0]
                == "Z"
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
        expiration = subprocess.run(
            ["python3", str(COMMAND), "expire", str(operation)],
            env=self.environment,
            capture_output=True,
            text=True,
            timeout=20,
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
            list(fallback.iterdir()), "unavailable tmpfs must not create disk-backed state"
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
            "guard", "bash", "-s", check=False, input_text="echo prepared >> '" + str(marker) + "'"
        )
        self.assertEqual(output.returncode, 0, output.stderr)
        self.assertEqual(marker.read_text().splitlines(), ["prepared"])


if __name__ == "__main__":
    unittest.main()
