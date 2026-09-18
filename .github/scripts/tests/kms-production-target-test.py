#!/usr/bin/env python3
"""Exercise current target-only verification through the protected workflow CLI."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "kms-production-migration.py"
TOOLS = HERE / "fixtures/kms-production-target-tools.py"
TARGET = "arn:aws:kms:us-west-2:251964670836:key/e68917e2-5541-4597-b6ef-7e9eb5670947"


class TargetProductionTest(unittest.TestCase):
    def invoke(self, scenario="success", overrides=None):
        with tempfile.TemporaryDirectory(prefix="kms-target-test-") as directory:
            root = Path(directory)
            binary = root / "bin"
            binary.mkdir()
            for name in ["curl", "aws", "pnpm"]:
                path = binary / name
                path.write_text(TOOLS.read_text())
                path.chmod(0o700)
            state_path = root / "provider.json"
            state_path.write_text(json.dumps({"scenario": scenario, "calls": []}))
            env = {
                **os.environ,
                "PATH": str(binary) + os.pathsep + os.environ["PATH"],
                "RUNNER_TEMP": str(root),
                "KMS_OPERATION": "verify-target",
                "GITHUB_REPOSITORY": "vm0-ai/okou",
                "GITHUB_REPOSITORY_ID": "1096175506",
                "GITHUB_REF": "refs/heads/main",
                "GITHUB_EVENT_NAME": "workflow_dispatch",
                "GITHUB_RUN_ID": "12345",
                "GITHUB_SHA": "a" * 40,
                "GITHUB_WORKFLOW_REF": "vm0-ai/okou/.github/workflows/kms-production-preflight.yml@refs/heads/main",
                "EXPECTED_DEPLOYMENT_ID": "dpl_fixture",
                "KMS_MIGRATION_ROLE_ARN": "arn:aws:iam::251964670836:role/vm0-kms-migration-github-32264",
                "AWS_REGION": "us-west-2",
                "SECRETS_KMS_KEY_ID": TARGET,
                "ACTIONS_ID_TOKEN_REQUEST_URL": "https://pipelines.actions.githubusercontent.com/oidc",
                "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "fixture-private-github-token",
                "NEON_PROJECT_ID": "hidden-lab-39609750",
                "NEON_API_KEY": "fixture-private-neon-token",
                "VERCEL_TOKEN": "fixture-private-vercel-token",
            }
            for name in [
                "DOPPLER_SERVICE_IDENTITY_ID",
                "EXPECTED_BACKUP_SHA256",
                "AWS_ACCESS_KEY_ID",
                "AWS_SECRET_ACCESS_KEY",
                "AWS_SESSION_TOKEN",
            ]:
                env.pop(name, None)
            env.update(overrides or {})
            result = subprocess.run(
                ["python3", str(SCRIPT)],
                env=env,
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
            path = root / "kms-production-reports/target-verification.json"
            raw = path.read_text() if path.exists() else "null"
            report = json.loads(raw)
            self.assertNotIn("fixture-private-", raw + result.stdout + result.stderr)
            self.assertFalse((root / "kms-production-canary").exists())
            if report:
                for key in [
                    "retirementCleared",
                    "productionConfigurationChanged",
                    "productionDataChanged",
                    "sourceCredentialsRead",
                    "sourceCanaryCreated",
                ]:
                    self.assertFalse(report[key])
            return result, report, json.loads(state_path.read_text())

    def test_target_only_success_needs_no_static_or_backup_credentials(self):
        result, report, state = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(report["collectionComplete"])
        self.assertTrue(report["targetSession"]["onlyTargetDecryptAllowed"])
        self.assertEqual(report["verification"]["totals"]["verified"], 3)
        self.assertEqual(state["calls"].count("verify"), 1)
        self.assertTrue(report["kmsCallsMade"])

    def test_renamed_repository_uses_the_same_protected_workflow(self):
        result, report, _ = self.invoke(
            overrides={
                "GITHUB_REPOSITORY": "maxandzoe/okou",
                "GITHUB_WORKFLOW_REF": "maxandzoe/okou/.github/workflows/kms-production-preflight.yml@refs/heads/main",
            }
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(report["collectionComplete"])

    def test_wrong_context_is_rejected_before_provider_access(self):
        for overrides in [
            {"GITHUB_REF": "refs/heads/feature"},
            {"GITHUB_REPOSITORY_ID": "1"},
            {"GITHUB_REPOSITORY": "another-owner/okou"},
            {"GITHUB_EVENT_NAME": "pull_request"},
            {"GITHUB_WORKFLOW_REF": "other"},
        ]:
            with self.subTest(overrides=overrides):
                result, report, state = self.invoke(overrides=overrides)
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(report)
                self.assertEqual(state["calls"], [])

    def test_invalid_configuration_is_recorded_before_provider_access(self):
        for overrides in [
            {"SECRETS_KMS_KEY_ID": "old"},
            {"EXPECTED_DEPLOYMENT_ID": ""},
            {"CURSOR": "cursor"},
        ]:
            with self.subTest(overrides=overrides):
                result, report, state = self.invoke(overrides=overrides)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(report["collectionComplete"])
                self.assertEqual(state["calls"], [])

    def test_session_failures_never_connect_to_production(self):
        for scenario in ["session-denied", "wrong-session"]:
            with self.subTest(scenario=scenario):
                result, report, state = self.invoke(scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(report["verificationStarted"])
                self.assertNotIn("connection", state["calls"])

    def test_incomplete_or_mismatched_proof_never_completes(self):
        for scenario in [
            "source-ciphertext",
            "wrong-database",
            "historical-manifest",
            "tool-failed",
        ]:
            with self.subTest(scenario=scenario):
                result, report, _ = self.invoke(scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(report["collectionComplete"])
                self.assertIsNone(report["kmsCallsMade"])
                if scenario == "tool-failed":
                    self.assertEqual(
                        report["verificationFailure"]["toolReport"]["failureDetails"],
                        {"stage": "process_rows", "code": "AccessDeniedException"},
                    )

    def test_deployment_or_connection_drift_keeps_proof_incomplete(self):
        for scenario in ["deployment-changed", "connection-changed"]:
            with self.subTest(scenario=scenario):
                result, report, _ = self.invoke(scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(report["collectionComplete"])
                self.assertTrue(report["verificationStarted"])
                self.assertEqual(report["verification"]["totals"]["verified"], 3)


if __name__ == "__main__":
    unittest.main()
