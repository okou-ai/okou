#!/usr/bin/env python3
"""Exercise preview isolation, failure cleanup and sanitized CLI reports."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "kms-recovery-snapshot-inspect.py"
TOOLS = HERE / "fixtures/kms-recovery-snapshot-tools.py"


class SnapshotInspectionTest(unittest.TestCase):
    def invoke(self, scenario="normal", overrides=None):
        with tempfile.TemporaryDirectory(
            prefix="snapshot-inspection-test-"
        ) as directory:
            root = Path(directory)
            binary = root / "bin"
            binary.mkdir()
            for name in ["curl", "psql", "aws", "pnpm"]:
                tool = binary / name
                tool.write_text(TOOLS.read_text())
                tool.chmod(0o700)
            state_path = root / "fixture.json"
            state_path.write_text(json.dumps({"scenario": scenario, "calls": []}))
            environment = {
                **os.environ,
                "PATH": str(binary) + os.pathsep + os.environ["PATH"],
                "FIXTURE_STATE": str(state_path),
                "RUNNER_TEMP": str(root),
                "GITHUB_REPOSITORY": "vm0-ai/vm0",
                "GITHUB_REF": "refs/heads/main",
                "GITHUB_EVENT_NAME": "workflow_dispatch",
                "GITHUB_RUN_ID": "12345",
                "GITHUB_RUN_ATTEMPT": "1",
                "GITHUB_SHA": "a" * 40,
                "GITHUB_WORKFLOW_REF": "vm0-ai/vm0/.github/workflows/kms-recovery-snapshot-inspect.yml@refs/heads/main",
                "NEON_PROJECT_ID": "hidden-lab-39609750",
                "NEON_API_KEY": "fixture-private-token",
                "SNAPSHOT_SHA256": hashlib.sha256(b"snapshot-manual").hexdigest(),
                "EXPECTED_CREATED_AT": "2026-02-16T05:57:00Z",
                "VERIFY_TARGET_CIPHERTEXT": "false",
                "KMS_MIGRATION_ROLE_ARN": "arn:aws:iam::251964670836:role/vm0-kms-migration-github-32264",
                "ACTIONS_ID_TOKEN_REQUEST_URL": "https://test.actions.githubusercontent.com/token",
                "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "fixture-private-oidc-request",
                **(overrides or {}),
            }
            result = subprocess.run(
                ["python3", str(SCRIPT)],
                env=environment,
                capture_output=True,
                text=True,
                timeout=20,
            )
            raw = (root / "kms-recovery-snapshot.json").read_text()
            for value in (raw, result.stdout, result.stderr):
                for secret in (
                    "fixture-private-password",
                    "fixture-private-token",
                    "fixture-private-oidc",
                    "fixture-private-session-secret",
                    "fixture-private-session-token",
                ):
                    self.assertNotIn(secret, value)
            report = json.loads(raw)
            state = json.loads(state_path.read_text())
            self.assertFalse(report["retirementCleared"])
            if environment["VERIFY_TARGET_CIPHERTEXT"] != "true":
                self.assertFalse(report["kmsCallsMade"])
            self.assertFalse(report["restoreFinalized"])
            self.assertFalse(report["productionDatabaseConnected"])
            for call in state["calls"]:
                if call["method"] != "GET":
                    self.assertIn(
                        (call["method"], call["path"]),
                        {
                            ("POST", "/snapshots/snapshot-manual/restore"),
                            ("POST", "/endpoints"),
                            ("DELETE", "/branches/br-preview"),
                        },
                    )
            return result, report, state

    def test_inspects_snapshot_and_records_recoverable_cleanup_without_clearance(self):
        result, report, state = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(report["collectionComplete"])
        self.assertTrue(report["cleanupComplete"])
        self.assertTrue(report["snapshotSetUnchanged"])
        self.assertTrue(report["productionEndpointsUnchanged"])
        self.assertTrue(report["deletedPreviewStillListed"])
        self.assertEqual(
            report["deletedPreviewRecoverableUntil"], "2026-09-18T00:00:00+00:00"
        )
        self.assertEqual(
            report["databases"][0]["records"][1]["rowsWithEnvelopeMarker"], 3
        )
        self.assertEqual(state["sqlCalls"], 1)

    def test_wrong_snapshot_time_stops_before_any_mutation(self):
        result, report, state = self.invoke(
            overrides={"EXPECTED_CREATED_AT": "2026-02-17T05:57:00Z"}
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["failure"], "snapshot_identity_mismatch")
        self.assertTrue(all(c["method"] == "GET" for c in state["calls"]))

    def test_target_only_session_verifies_restored_ciphertext_and_cleans_up(self):
        result, report, state = self.invoke(
            overrides={"VERIFY_TARGET_CIPHERTEXT": "true"}
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(report["cryptographicVerification"])
        self.assertTrue(report["nestedPayloadInspection"])
        self.assertTrue(report["cleanupComplete"])
        self.assertTrue(report["targetSession"]["onlyTargetDecryptAllowed"])
        self.assertEqual(
            report["databases"][0]["targetVerification"]["totals"]["verified"], 3
        )
        self.assertEqual(state["targetVerificationCalls"], 1)

    def test_session_denial_or_wrong_identity_prevents_restore(self):
        for scenario in ["target-session-denied", "wrong-target-identity"]:
            with self.subTest(scenario=scenario):
                result, report, state = self.invoke(
                    scenario, {"VERIFY_TARGET_CIPHERTEXT": "true"}
                )
                self.assertEqual(result.returncode, 1)
                self.assertFalse(report["previewCreated"])
                self.assertTrue(all(c["method"] == "GET" for c in state["calls"]))

    def test_failed_or_mismatched_target_proof_does_not_clear_recovery(self):
        for scenario in [
            "target-verification-failed",
            "target-nested-source",
            "target-report-wrong-database",
        ]:
            with self.subTest(scenario=scenario):
                result, report, _ = self.invoke(
                    scenario, {"VERIFY_TARGET_CIPHERTEXT": "true"}
                )
                self.assertEqual(result.returncode, 1)
                self.assertFalse(report["cryptographicVerification"])
                self.assertFalse(report["collectionComplete"])
                self.assertTrue(report["cleanupComplete"])

    def test_created_endpoint_is_read_back_without_project_list_visibility(self):
        result, report, state = self.invoke("endpoint-absent-from-project-list")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(report["collectionComplete"])
        self.assertTrue(report["cleanupComplete"])
        self.assertEqual(report["previewEndpointCountBeforeCreate"], 0)
        self.assertEqual(report["createdPreviewEndpointId"], "ep-preview")
        self.assertEqual(state["sqlCalls"], 1)

    def test_endpoint_readback_cannot_retarget_production(self):
        result, report, state = self.invoke("endpoint-readback-production")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["failure"], "preview_endpoint_identity_mismatch")
        self.assertTrue(report["cleanupComplete"])
        self.assertNotIn("sqlCalls", state)

    def test_multiple_preview_primaries_report_count_without_connecting(self):
        result, report, state = self.invoke("ambiguous-preview-endpoints")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["failure"], "preview_primary_endpoint_not_unique")
        self.assertEqual(report["previewEndpointCountBeforeCreate"], 2)
        self.assertTrue(report["cleanupComplete"])
        self.assertNotIn("sqlCalls", state)

    def test_preview_primary_with_replica_pins_primary_without_creating_compute(self):
        result, report, state = self.invoke("preview-primary-and-replica")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["previewEndpointCountBeforeCreate"], 2)
        self.assertEqual(
            report["previewEndpointTypeCountsBeforeCreate"],
            {"read_write": 1, "read_only": 1},
        )
        self.assertEqual(report["selectedPreviewEndpointId"], "ep-preview")
        self.assertEqual(report["selectedPreviewEndpointType"], "read_write")
        self.assertFalse(
            any(
                c["method"] == "POST" and c["path"] == "/endpoints"
                for c in state["calls"]
            )
        )
        self.assertTrue(report["cleanupComplete"])

    def test_preview_with_only_replica_creates_and_pins_own_primary(self):
        result, report, state = self.invoke("preview-replica-only")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["previewEndpointCountBeforeCreate"], 1)
        self.assertEqual(report["createdPreviewEndpointId"], "ep-preview")
        self.assertEqual(report["selectedPreviewEndpointType"], "read_write")
        self.assertTrue(report["cleanupComplete"])

    def test_duplicate_endpoint_ids_fail_before_connection(self):
        result, report, state = self.invoke("duplicate-preview-endpoint")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["failure"], "duplicate_preview_endpoint_id")
        self.assertNotIn("sqlCalls", state)
        self.assertTrue(report["cleanupComplete"])

    def test_primary_readback_cannot_change_to_replica(self):
        result, report, state = self.invoke("endpoint-readback-replica")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["failure"], "preview_endpoint_identity_mismatch")
        self.assertNotIn("sqlCalls", state)
        self.assertTrue(report["cleanupComplete"])

    def test_production_returned_as_preview_never_connects_or_deletes(self):
        result, report, state = self.invoke("production-returned")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["failure"], "preview_is_existing_branch")
        self.assertNotIn("sqlCalls", state)
        self.assertFalse(any(c["method"] == "DELETE" for c in state["calls"]))

    def test_wrong_database_endpoint_is_rejected_and_preview_removed(self):
        result, report, state = self.invoke("production-uri")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["failure"], "isolated_connection_identity_mismatch")
        self.assertNotIn("sqlCalls", state)
        self.assertTrue(report["cleanupComplete"])

    def test_database_failure_keeps_aggregate_error_and_cleans_up(self):
        result, report, _ = self.invoke("sql-failure")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["failure"], "snapshot_database_scan_failed")
        self.assertTrue(report["cleanupComplete"])
        self.assertFalse(report["collectionComplete"])

    def test_cleanup_denial_is_incomplete_even_after_successful_scan(self):
        result, report, _ = self.invoke("cleanup-denied")
        self.assertEqual(result.returncode, 1)
        self.assertTrue(report["collectionComplete"])
        self.assertFalse(report["cleanupComplete"])
        self.assertEqual(report["cleanupFailure"], "preview_cleanup_unconfirmed")

    def test_uncertain_restore_is_not_retried_or_blindly_deleted(self):
        result, report, state = self.invoke("unknown-restore-outcome")
        self.assertEqual(result.returncode, 1)
        self.assertTrue(report["restoreRequestStarted"])
        self.assertEqual(report["failure"], "neon_request_outcome_unconfirmed")
        self.assertEqual(sum(c["method"] == "POST" for c in state["calls"]), 1)
        self.assertFalse(any(c["method"] == "DELETE" for c in state["calls"]))

    def test_existing_preview_and_incomplete_pagination_block_new_restore(self):
        for scenario in ("existing-preview", "repeated-page"):
            with self.subTest(scenario=scenario):
                result, _, state = self.invoke(scenario)
                self.assertEqual(result.returncode, 1)
                self.assertTrue(all(c["method"] == "GET" for c in state["calls"]))

    def test_non_main_invocation_never_calls_neon(self):
        result, report, state = self.invoke(
            overrides={"GITHUB_REF": "refs/heads/feature"}
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["failure"], "unprotected_invocation")
        self.assertEqual(state["calls"], [])


if __name__ == "__main__":
    unittest.main()
