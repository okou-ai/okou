#!/usr/bin/env python3
"""Test the protected CLI's key effects and durable operator receipts."""

import base64
import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile


HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "kms-production-migration.py"
TOOLS = HERE / "fixtures/kms-production-retirement-tools.py"
SOURCE = "arn:aws:kms:us-west-2:072707626411:key/a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8"
TARGET = "arn:aws:kms:us-west-2:251964670836:key/e68917e2-5541-4597-b6ef-7e9eb5670947"


class RetirementCliTest(unittest.TestCase):
    def invoke(self, scenario="success", overrides=None):
        with tempfile.TemporaryDirectory(prefix="kms-retirement-test-") as directory:
            root = Path(directory)
            binary = root / "bin"
            binary.mkdir()
            for name in ["aws", "curl", "gh"]:
                wrapper = binary / name
                wrapper.write_text(TOOLS.read_text())
                wrapper.chmod(0o700)
            now = datetime.datetime.now(datetime.timezone.utc)
            snapshot = {
                "version": 1,
                "sourceKeyArn": SOURCE,
                "sourcePrincipal": "arn:aws:iam::072707626411:user/vm0-kms-prod",
                "workflow": {
                    "repository": "vm0-ai/vm0",
                    "commit": "594d907ca844e845f674c04640a58ae8cebcdc8a",
                    "runId": "34324494642",
                },
                "configuration": {
                    "AWS_ACCESS_KEY_ID": "synthetic-source-access-key",
                    "AWS_SECRET_ACCESS_KEY": "synthetic-source-secret",
                    "AWS_REGION": "us-west-2",
                    "SECRETS_KMS_KEY_ID": "alias/vm0-secrets-prod",
                },
            }
            deployment = {
                "id": "dpl_verified",
                "url": "verified.example",
                "commit": "b" * 40,
            }
            totals = {
                name: 0
                for name in [
                    "source",
                    "nestedSource",
                    "nestedUninspected",
                    "unknownKey",
                    "invalid",
                    "nonArn",
                    "updated",
                    "concurrentChanges",
                ]
            }
            totals.update(rows=42, target=42, verified=42)
            proof = {
                "version": 1,
                "operation": "verify-target",
                "runId": "54321",
                "commit": "a" * 40,
                "source": SOURCE,
                "target": TARGET,
                "result": "passed",
                "collectionComplete": True,
                "verificationStarted": True,
                "kmsCallsMade": True,
                "retirementCleared": False,
                "productionConfigurationChanged": False,
                "productionDataChanged": False,
                "sourceCredentialsRead": False,
                "sourceCanaryCreated": False,
                "startedAt": (now - datetime.timedelta(hours=1)).isoformat(),
                "finishedAt": (now - datetime.timedelta(minutes=5)).isoformat(),
                "deployment": deployment,
                "targetSession": {
                    "onlyTargetDecryptAllowed": True,
                    "principal": "arn:aws:sts::251964670836:assumed-role/vm0-kms-migration-github-32264/kms-recovery-54321",
                    "sessionPolicySha256": "1cd509f6b8254482cd89b649b1a574eaa300ca1ee095a3f656770dfad91a4231",
                    "expiration": (now + datetime.timedelta(hours=1)).isoformat(),
                },
                "verification": {
                    "manifest": "cf1a3570fa3fd0039e7e40979a5047f7f90f597149dff6deda146c2bf340ffb8",
                    "totals": totals,
                },
            }
            if scenario == "nested-source":
                totals["nestedSource"] = 1
            if scenario == "incomplete-proof":
                proof["collectionComplete"] = False
            if scenario == "wrong-policy":
                proof["targetSession"]["sessionPolicySha256"] = "0" * 64
            if scenario == "expired-proof":
                proof["startedAt"] = (now - datetime.timedelta(hours=8)).isoformat()
                proof["finishedAt"] = (now - datetime.timedelta(hours=7)).isoformat()
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w") as archive:
                archive.writestr("target-verification.json", json.dumps(proof))
            archive_bytes = buffer.getvalue()
            digest = hashlib.sha256(archive_bytes).hexdigest()
            key = {
                "Arn": SOURCE,
                "KeyId": SOURCE.rsplit("/", 1)[1],
                "AWSAccountId": "072707626411",
                "KeyManager": "CUSTOMER",
                "Origin": "AWS_KMS",
                "KeyUsage": "ENCRYPT_DECRYPT",
                "KeySpec": "SYMMETRIC_DEFAULT",
                "MultiRegion": False,
                "KeyState": "Enabled",
                "Enabled": True,
            }
            if scenario == "already-pending":
                key.update(
                    KeyState="PendingDeletion",
                    Enabled=False,
                    DeletionDate=(now + datetime.timedelta(days=3)).isoformat(),
                )
            if scenario == "wrong-key-type":
                key["MultiRegion"] = True
            run = {
                "id": 54321,
                "repository": {"full_name": "vm0-ai/okou"},
                "workflow_id": 353130414,
                "path": ".github/workflows/kms-production-preflight.yml",
                "event": "workflow_dispatch",
                "actor": {"login": "hulh122"},
                "head_branch": "main",
                "status": "completed",
                "conclusion": "success",
                "run_attempt": 1,
                "head_sha": "a" * 40,
            }
            if scenario == "wrong-run":
                run["conclusion"] = "failure"
            if scenario == "wrong-repository":
                run["repository"]["full_name"] = "another-owner/okou"
            if scenario == "wrong-actor":
                run["actor"]["login"] = "another-user"
            state = {
                "scenario": scenario,
                "snapshot": snapshot,
                "deployment": deployment,
                "key": key,
                "targetKey": {"Arn": TARGET, "KeyState": "Enabled"},
                "run": run,
                "archive": base64.b64encode(archive_bytes).decode(),
                "artifact": {
                    "id": 123,
                    "name": "kms-production-verification-54321-1",
                    "expired": False,
                    "size_in_bytes": len(archive_bytes),
                    "workflow_run": {"id": 54321, "head_sha": "a" * 40},
                    "digest": "sha256:" + digest,
                },
                "deploymentReads": 0,
                "scheduleRequests": 0,
                "eventTime": (now - datetime.timedelta(hours=1)).isoformat(),
            }
            state_path = root / "provider.json"
            state_path.write_text(json.dumps(state))
            env = {
                **os.environ,
                "PATH": str(binary) + os.pathsep + os.environ["PATH"],
                "RUNNER_TEMP": str(root),
                "KMS_OPERATION": "retire-source",
                "GITHUB_RUN_ATTEMPT": "1",
                "GITHUB_REPOSITORY": "vm0-ai/okou",
                "GITHUB_REF": "refs/heads/main",
                "GITHUB_EVENT_NAME": "workflow_dispatch",
                "GITHUB_RUN_ID": "12345",
                "GITHUB_SHA": "c" * 40,
                "GITHUB_WORKFLOW_REF": "vm0-ai/okou/.github/workflows/kms-production-retire.yml@refs/heads/main",
                "EXPECTED_BACKUP_SHA256": hashlib.sha256(
                    json.dumps(snapshot, separators=(",", ":")).encode()
                ).hexdigest(),
                "DOPPLER_SERVICE_IDENTITY_ID": "c0c87790-e651-45dd-b7fa-c5ed07bb990f",
                "ACTIONS_ID_TOKEN_REQUEST_URL": "https://pipelines.actions.githubusercontent.com/oidc",
                "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "synthetic-github-secret",
                "GH_TOKEN": "synthetic-github-secret",
                "VERCEL_TOKEN": "synthetic-vercel-secret",
                "AWS_ENDPOINT_URL": "https://must-not-propagate.invalid",
                "SOURCE_AUDIT_WINDOW_START": (
                    now - datetime.timedelta(hours=2)
                ).isoformat(),
                "VERIFICATION_RUN_ID": "54321",
                "VERIFICATION_ARTIFACT_SHA256": digest,
                "EXPECTED_DEPLOYMENT_ID": "dpl_verified",
                "ACCEPT_HISTORICAL_RECOVERY_LOSS": "true",
            }
            env.update(overrides or {})
            result = subprocess.run(
                ["python3", str(SCRIPT)],
                env=env,
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
            provider = json.loads(state_path.read_text())
            path = root / "kms-source-retirement-reports/source-retirement.json"
            report = json.loads(path.read_text()) if path.exists() else None
            emitted = result.stdout + result.stderr + json.dumps(report)
            for secret in [
                "synthetic-source-access-key",
                "synthetic-source-secret",
                "synthetic-github-secret",
                "synthetic-vercel-secret",
                "synthetic-oidc-secret",
                "synthetic-doppler-secret",
                "synthetic-private-principal",
                "synthetic-provider-secret-must-not-leak",
            ]:
                self.assertNotIn(secret, emitted)
            self.assertEqual(provider["snapshot"], snapshot)
            self.assertEqual(provider["targetKey"]["KeyState"], "Enabled")
            return result, provider, report

    def test_schedules_only_old_key_and_returns_actual_pending_date(self):
        result, provider, report = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(provider["key"]["KeyState"], "PendingDeletion")
        self.assertEqual(report["result"], "pending_deletion")
        self.assertEqual(report["deletionDate"], provider["key"]["DeletionDate"])
        self.assertEqual(report["mutationEffects"], "scheduled")
        self.assertFalse(report["physicalDeletionConfirmed"])

    def test_proof_and_artifact_failures_leave_key_usable(self):
        for scenario in [
            "wrong-run",
            "wrong-repository",
            "wrong-actor",
            "archive-changed",
            "nested-source",
            "incomplete-proof",
            "wrong-policy",
            "expired-proof",
        ]:
            with self.subTest(scenario=scenario):
                result, provider, report = self.invoke(scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(provider["key"]["KeyState"], "Enabled")
                self.assertFalse(report["mutationAttempted"])

    def test_new_crypto_or_unreadable_audit_blocks_retirement(self):
        for scenario in ["source-crypto", "audit-denied"]:
            with self.subTest(scenario=scenario):
                result, provider, report = self.invoke(scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(provider["key"]["KeyState"], "Enabled")
                self.assertFalse(report["mutationAttempted"])

    def test_changed_source_identity_or_deployment_never_schedules(self):
        for scenario in [
            "wrong-key",
            "wrong-key-type",
            "wrong-principal",
            "backup-changed",
            "deployment-changed",
        ]:
            with self.subTest(scenario=scenario):
                result, provider, report = self.invoke(scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(provider["key"]["KeyState"], "Enabled")
                self.assertFalse(report["mutationAttempted"])

    def test_already_pending_date_is_preserved_without_rescheduling(self):
        result, provider, report = self.invoke("already-pending")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            report["keyBefore"]["deletionDate"], provider["key"]["DeletionDate"]
        )
        self.assertEqual(provider["scheduleRequests"], 0)
        self.assertFalse(report["mutationAttempted"])

    def test_lost_schedule_response_is_unknown_and_never_retried(self):
        result, provider, report = self.invoke("lost-response")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(provider["key"]["KeyState"], "PendingDeletion")
        self.assertEqual(provider["scheduleRequests"], 1)
        self.assertEqual(report["mutationEffects"], "unknown")
        self.assertEqual(report["awsFailure"]["operation"], "kms:ScheduleKeyDeletion")

    def test_schedule_denial_retains_specific_permission_failure(self):
        result, provider, report = self.invoke("schedule-denied")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(provider["key"]["KeyState"], "Enabled")
        self.assertEqual(report["awsFailure"]["errorCode"], "AccessDeniedException")
        self.assertEqual(provider["scheduleRequests"], 1)

    def test_status_distinguishes_missing_key_from_permission_denial(self):
        for scenario, outcome in [
            ("success", "observed"),
            ("not-found", "key_not_found"),
            ("describe-denied", "failed"),
        ]:
            with self.subTest(scenario=scenario):
                result, provider, report = self.invoke(
                    scenario, {"KMS_OPERATION": "source-status"}
                )
                self.assertEqual(result.returncode == 0, scenario != "describe-denied")
                self.assertEqual(report["result"], outcome)
                self.assertEqual(provider["scheduleRequests"], 0)
                self.assertFalse(report["physicalDeletionConfirmed"])

    def test_reruns_and_unprotected_contexts_cannot_mutate(self):
        for overrides in [
            {"GITHUB_RUN_ATTEMPT": "2"},
            {"GITHUB_REF": "refs/heads/feature"},
            {"GITHUB_REPOSITORY": "another-owner/okou"},
            {"GITHUB_WORKFLOW_REF": "other"},
            {"ACCEPT_HISTORICAL_RECOVERY_LOSS": "false"},
        ]:
            with self.subTest(overrides=overrides):
                result, provider, _ = self.invoke(overrides=overrides)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(provider["key"]["KeyState"], "Enabled")
                self.assertEqual(provider["scheduleRequests"], 0)


if __name__ == "__main__":
    unittest.main()
