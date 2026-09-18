#!/usr/bin/env python3
"""Exercise the real protected CLI with isolated AWS and Doppler commands."""

import hashlib
import datetime
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "kms-production-migration.py"
TOOLS = HERE / "fixtures/kms-production-source-audit-tools.py"
SOURCE = "arn:aws:kms:us-west-2:072707626411:key/a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8"


class SourceAuditCliTest(unittest.TestCase):
    def invoke(self, scenario="empty", overrides=None):
        with tempfile.TemporaryDirectory(prefix="kms-source-audit-test-") as directory:
            root = Path(directory)
            binary = root / "bin"
            binary.mkdir()
            for name in ["aws", "curl"]:
                wrapper = binary / name
                wrapper.write_text(TOOLS.read_text())
                wrapper.chmod(0o700)
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
            raw = json.dumps(snapshot, separators=(",", ":"))
            start = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(
                hours=2
            )
            state_path = root / "provider.json"
            state_path.write_text(
                json.dumps(
                    {
                        "scenario": scenario,
                        "snapshot": snapshot,
                        "calls": [],
                        "windowStart": start.isoformat(),
                        "eventTime": (
                            start + datetime.timedelta(minutes=15)
                        ).isoformat(),
                    }
                )
            )
            env = {
                **os.environ,
                "PATH": str(binary) + os.pathsep + os.environ["PATH"],
                "KMS_OPERATION": "source-audit",
                "SOURCE_AUDIT_WINDOW_START": start.isoformat(),
                "RUNNER_TEMP": str(root),
                "GITHUB_REPOSITORY": "vm0-ai/okou",
                "GITHUB_REPOSITORY_ID": "1096175506",
                "GITHUB_REF": "refs/heads/main",
                "GITHUB_EVENT_NAME": "workflow_dispatch",
                "GITHUB_RUN_ID": "12345",
                "GITHUB_SHA": "a" * 40,
                "GITHUB_WORKFLOW_REF": "vm0-ai/okou/.github/workflows/kms-production-preflight.yml@refs/heads/main",
                "EXPECTED_BACKUP_SHA256": hashlib.sha256(raw.encode()).hexdigest(),
                "DOPPLER_SERVICE_IDENTITY_ID": "c0c87790-e651-45dd-b7fa-c5ed07bb990f",
                "ACTIONS_ID_TOKEN_REQUEST_URL": "https://pipelines.actions.githubusercontent.com/oidc",
                "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "synthetic-github-secret",
                "VERCEL_TOKEN": "synthetic-vercel-secret",
                "NEON_API_KEY": "synthetic-neon-secret",
                "AWS_ENDPOINT_URL": "https://must-not-propagate.invalid",
            }
            env.pop("EXPECTED_DEPLOYMENT_ID", None)
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
            report_path = root / "kms-production-reports/source-audit.json"
            report = (
                json.loads(report_path.read_text()) if report_path.exists() else None
            )
            emitted = result.stdout + result.stderr + json.dumps(report)
            for secret in [
                "synthetic-source-access-key",
                "synthetic-source-secret",
                "synthetic-github-secret",
                "synthetic-oidc-secret",
                "synthetic-doppler-secret",
                "synthetic-private-identity",
                "synthetic-private-principal",
                "synthetic-next-page-secret",
                "synthetic-provider-secret-must-not-leak",
            ]:
                self.assertNotIn(secret, emitted)
            self.assertEqual(state["snapshot"], snapshot)
            self.assertFalse((root / "kms-production-canary").exists())
            if report:
                self.assertFalse(report["retirementCleared"])
                self.assertFalse(report["kmsCallsMade"])
                self.assertFalse(report["productionConfigurationChanged"])
                self.assertFalse(report["staticCredentialsCreated"])
                self.assertFalse(report["lateArrivalExcluded"])
            return result, state, report

    def test_empty_complete_window_makes_only_two_lookup_queries(self):
        result, state, report = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(report["collectionComplete"])
        self.assertEqual(report["totals"]["uniqueEvents"], 0)
        self.assertEqual(
            state["calls"],
            [
                "oidc",
                "doppler-auth",
                "backup-read",
                "source-sts",
                "lookup-arn",
                "lookup-id",
            ],
        )

    def test_pagination_and_duplicate_queries_count_an_event_once(self):
        result, state, report = self.invoke("pagination")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([query["pages"] for query in report["queries"]], [2, 2])
        self.assertEqual(report["totals"]["uniqueEvents"], 1)
        self.assertEqual(report["totals"]["cryptographicOperations"], 0)
        self.assertTrue(report["events"][0]["matchesRetainedSourceCredential"])

    def test_crypto_and_unclassified_events_remain_visible_without_raw_payloads(self):
        for scenario, category in [
            ("crypto", "cryptographicOperations"),
            ("unknown-event", "unclassifiedOperations"),
        ]:
            with self.subTest(scenario=scenario):
                result, _, report = self.invoke(scenario)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(report["totals"][category], 1)

    def test_denied_or_incomplete_pages_never_report_a_complete_window(self):
        for scenario in [
            "denied",
            "partial-denied",
            "repeated-token",
            "wrong-event-scope",
            "duplicate-changed",
        ]:
            with self.subTest(scenario=scenario):
                result, _, report = self.invoke(scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(report["collectionComplete"])
                self.assertEqual(report["result"], "failed")
                if "denied" in scenario:
                    self.assertEqual(
                        report["awsFailure"]["operation"], "cloudtrail:LookupEvents"
                    )
                    self.assertEqual(
                        report["awsFailure"]["errorCode"], "AccessDeniedException"
                    )
                if scenario == "partial-denied":
                    self.assertEqual(len(report["events"]), 1)

    def test_bad_identity_and_changed_backup_stop_before_cloudtrail(self):
        for scenario in ["wrong-account", "backup-changed"]:
            with self.subTest(scenario=scenario):
                result, state, report = self.invoke(scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(report["collectionComplete"])
                self.assertFalse(
                    any(call.startswith("lookup") for call in state["calls"])
                )

    def test_unprotected_context_and_verify_without_deployment_stop_before_providers(
        self,
    ):
        for overrides in [
            {"GITHUB_REF": "refs/heads/feature"},
            {"GITHUB_REPOSITORY_ID": "1"},
            {"GITHUB_REPOSITORY": "another-owner/okou"},
            {"GITHUB_EVENT_NAME": "pull_request"},
            {"GITHUB_WORKFLOW_REF": "other-workflow"},
            {"KMS_OPERATION": "verify"},
        ]:
            with self.subTest(overrides=overrides):
                result, state, report = self.invoke(overrides=overrides)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(state["calls"], [])
                self.assertIsNone(report)

    def test_expired_history_window_stops_before_reading_credentials(self):
        start = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(
            days=91
        )
        result, state, report = self.invoke(
            overrides={"SOURCE_AUDIT_WINDOW_START": start.isoformat()}
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(state["calls"], [])
        self.assertEqual(report["failure"], "audit_window_expired")
        self.assertFalse(report["collectionComplete"])


if __name__ == "__main__":
    unittest.main()
