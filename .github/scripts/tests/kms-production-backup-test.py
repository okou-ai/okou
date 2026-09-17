#!/usr/bin/env python3
"""Exercise the real backup CLI with isolated external command fixtures."""

import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "kms-production-backup.py"
TOOLS = HERE / "fixtures/kms-production-backup-tools.py"
SOURCE_KEY = (
    "arn:aws:kms:us-west-2:072707626411:key/a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8"
)
CONFIGURATION = {
    "AWS_ACCESS_KEY_ID": "AKIAFIXTURE0000000000",
    "AWS_SECRET_ACCESS_KEY": "synthetic-secret-for-backup-verification",
    "SECRETS_KMS_KEY_ID": SOURCE_KEY,
    "AWS_REGION": "us-west-2",
}


class BackupCliTest(unittest.TestCase):
    def invoke(self, scenario="success", overrides=None):
        with tempfile.TemporaryDirectory(prefix="kms-backup-test-") as directory:
            root = Path(directory)
            binary = root / "bin"
            binary.mkdir()
            for name in ["aws", "curl"]:
                wrapper = binary / name
                wrapper.write_text(TOOLS.read_text())
                wrapper.chmod(0o700)
            state_path = root / "provider-state.json"
            initial = {
                "scenario": scenario,
                "requests": [],
                "secrets": {},
                "writes": 0,
                "deploymentReads": 0,
            }
            if scenario == "existing-backup":
                initial["secrets"]["KMS_BACKUP_JSON"] = {
                    "raw": "existing-original",
                    "computed": "existing-original",
                }
            state_path.write_text(json.dumps(initial))
            env = {
                **os.environ,
                **CONFIGURATION,
                "PATH": str(binary) + os.pathsep + os.environ["PATH"],
                "BACKUP_FIXTURE_STATE": str(state_path),
                "RUNNER_TEMP": str(root),
                "AWS_SESSION_TOKEN": "",
                "GITHUB_REPOSITORY": "vm0-ai/okou",
                "GITHUB_REPOSITORY_ID": "1096175506",
                "GITHUB_REF": "refs/heads/main",
                "GITHUB_EVENT_NAME": "workflow_dispatch",
                "GITHUB_RUN_ID": "12345",
                "GITHUB_SHA": "a" * 40,
                "GITHUB_WORKFLOW_REF": "vm0-ai/okou/.github/workflows/kms-production-backup.yml@refs/heads/main",
                "DOPPLER_SERVICE_IDENTITY_ID": "c0c87790-e651-45dd-b7fa-c5ed07bb990f",
                "ACTIONS_ID_TOKEN_REQUEST_URL": "https://pipelines.actions.githubusercontent.com/oidc?existing=1",
                "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "github-request-fixture",
                "VERCEL_TOKEN": "vercel-fixture-secret",
                "EXPECTED_DEPLOYMENT_ID": "dpl_fixture",
                "UNRELATED_SECRET": "must-not-enter-the-backup",
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
            state = json.loads(state_path.read_text())
            report_path = root / "kms-production-backup.json"
            report = (
                json.loads(report_path.read_text()) if report_path.exists() else None
            )
            for secret in [
                CONFIGURATION["AWS_ACCESS_KEY_ID"],
                CONFIGURATION["AWS_SECRET_ACCESS_KEY"],
                "oidc-fixture-secret",
                "doppler-fixture-secret",
                "vercel-fixture-secret",
                env["UNRELATED_SECRET"],
            ]:
                self.assertNotIn(
                    secret, result.stdout + result.stderr + json.dumps(report)
                )
            return result, state, report

    def test_backup_preserves_effective_values_and_records_deployment_without_leaking(
        self,
    ):
        result, state, report = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(state["writes"], 1)
        self.assertEqual(set(state["secrets"]), {"KMS_BACKUP_JSON"})
        snapshot = json.loads(state["secrets"]["KMS_BACKUP_JSON"]["raw"])
        self.assertEqual(snapshot["configuration"], CONFIGURATION)
        self.assertEqual(
            snapshot["deployment"],
            {"id": "dpl_fixture", "url": "fixture.vm6.ai", "commit": "b" * 40},
        )
        self.assertEqual(snapshot["workflow"]["runId"], "12345")
        self.assertTrue(report["readbackVerified"])
        self.assertEqual(
            report["snapshotSha256"],
            hashlib.sha256(
                state["secrets"]["KMS_BACKUP_JSON"]["raw"].encode()
            ).hexdigest(),
        )
        self.assertFalse(report["productionConfigurationChanged"])

    def test_renamed_repository_records_new_provenance(self):
        result, state, _ = self.invoke(
            overrides={
                "GITHUB_REPOSITORY": "maxandzoe/okou",
                "GITHUB_WORKFLOW_REF": "maxandzoe/okou/.github/workflows/kms-production-backup.yml@refs/heads/main",
            }
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        snapshot = json.loads(state["secrets"]["KMS_BACKUP_JSON"]["raw"])
        self.assertEqual(snapshot["workflow"]["repository"], "maxandzoe/okou")

    def test_wrong_principal_stops_before_backup(self):
        result, state, report = self.invoke("wrong-principal")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("source_principal_mismatch", result.stderr)
        self.assertEqual(state["writes"], 0)
        self.assertIsNone(report)

    def test_backup_preserves_the_original_alias_for_configuration_rollback(self):
        result, state, report = self.invoke(
            overrides={"SECRETS_KMS_KEY_ID": "alias/vm0-secrets-prod"}
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        snapshot = json.loads(state["secrets"]["KMS_BACKUP_JSON"]["raw"])
        self.assertEqual(
            snapshot["configuration"]["SECRETS_KMS_KEY_ID"], "alias/vm0-secrets-prod"
        )
        self.assertEqual(report["sourceKeyArn"], SOURCE_KEY)

    def test_unprotected_branch_and_target_key_are_rejected(self):
        for overrides in [
            {"GITHUB_REF": "refs/heads/unprotected"},
            {"GITHUB_REPOSITORY_ID": "1"},
            {"SECRETS_KMS_KEY_ID": "alias/unexpected"},
            {"DOPPLER_SERVICE_IDENTITY_ID": "development-identity"},
            {"EXPECTED_DEPLOYMENT_ID": "dpl_unexpected"},
        ]:
            with self.subTest(overrides=overrides):
                result, state, report = self.invoke(overrides=overrides)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(state["writes"], 0)
                self.assertIsNone(report)

    def test_existing_and_concurrent_backups_are_never_overwritten(self):
        for scenario, original in [
            ("existing-backup", "existing-original"),
            ("concurrent-backup", "concurrent-original"),
        ]:
            with self.subTest(scenario=scenario):
                result, state, report = self.invoke(scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(state["secrets"]["KMS_BACKUP_JSON"]["raw"], original)
                self.assertEqual(state["writes"], 0)
                self.assertIsNone(report)

    def test_deployment_change_prevents_creating_stale_rollback_record(self):
        result, state, report = self.invoke("changed-deployment")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("production_deployment_changed", result.stderr)
        self.assertEqual(state["writes"], 0)
        self.assertIsNone(report)

    def test_readback_mismatch_cannot_report_success(self):
        result, state, report = self.invoke("readback-mismatch")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("backup_readback_mismatch", result.stderr)
        self.assertEqual(state["writes"], 1)
        self.assertIsNone(report)

    def test_provider_error_body_is_never_emitted(self):
        result, state, report = self.invoke("provider-error")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("provider_request_rejected", result.stderr)
        self.assertEqual(state["writes"], 0)
        self.assertIsNone(report)


if __name__ == "__main__":
    unittest.main()
