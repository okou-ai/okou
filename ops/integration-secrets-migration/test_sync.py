"""Exercise the manual migration CLI with isolated external provider responses."""

import base64
import contextlib
import io
import json
import os
import runpy
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("sync.py")
MODULE = runpy.run_path(str(SCRIPT))
KEYS = MODULE["SOURCE_KEYS"]
PROD_ONLY = MODULE["PRODUCTION_ONLY"]


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class Provider:
    def __init__(self, config, claims, lose_write_response=False, reject=False):
        self.config = config
        self.claims = claims
        self.secrets = {
            "UNRELATED": {"raw": "retain-existing", "computed": "retain-existing"}
        }
        self.payloads = []
        self.lose_write_response = lose_write_response
        self.reject = reject

    def open(self, request, timeout):
        self.assert_request(request, timeout)
        if request.full_url.startswith("https://token.actions.githubusercontent.com/"):
            jwt = (
                base64.urlsafe_b64encode(json.dumps(self.claims).encode())
                .decode()
                .rstrip("=")
            )
            data = {"value": "header." + jwt + ".signature"}
        elif request.full_url.endswith("/auth/oidc"):
            data = {"token": "provider-write-credential"}
        elif request.get_method() == "POST":
            payload = json.loads(request.data)
            assert payload["project"] == "vm0" and payload["config"] == self.config
            self.payloads.append(payload)
            if self.reject:
                raise urllib.error.URLError(
                    "provider-write-credential and private-source-value"
                )
            self.secrets.update(
                {k: {"raw": v, "computed": v} for k, v in payload["secrets"].items()}
            )
            if self.lose_write_response:
                raise urllib.error.URLError(
                    "provider-write-credential and private-source-value"
                )
            data = {"success": True}
        else:
            assert f"config={self.config}" in request.full_url
            data = {"success": True, "secrets": self.secrets}
        return Response(json.dumps(data).encode())

    @staticmethod
    def assert_request(request, timeout):
        assert timeout == 30
        assert request.full_url.startswith(
            (
                "https://token.actions.githubusercontent.com/",
                "https://api.doppler.com/v3/",
            )
        )


class MigrationTests(unittest.TestCase):
    def invoke(self, config, changes=None, lose=False, reject=False):
        commit = "a" * 40
        env = {
            "MIGRATION_CONFIG": config,
            "GITHUB_REPOSITORY": "okou-ai/okou",
            "GITHUB_REPOSITORY_ID": "1096175506",
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_WORKFLOW_REF": MODULE["WORKFLOW"],
            "GITHUB_SHA": commit,
            "EXPECTED_COMMIT": commit,
            "GITHUB_RUN_ID": "123",
            "DOPPLER_WRITE_IDENTITY": "temporary-identity",
            "ACTIONS_ID_TOKEN_REQUEST_URL": "https://token.actions.githubusercontent.com/token?existing=query",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "oidc-credential",
        }
        expected = set(KEYS) - (PROD_ONLY if config == "dev" else set())
        env.update({"SOURCE_" + k: "private-source-value-" + k for k in expected})
        env["SOURCE_OKOU_GITHUB_APP_PRIVATE_KEY"] = (
            "private-source-value\nmultiline-private-key\n"
        )
        env.update(changes or {})
        claims = {
            "repository_id": "1096175506",
            "workflow_ref": MODULE["WORKFLOW"],
            "sha": commit,
        }
        if config == "prd":
            claims["environment"] = "production"
        provider = Provider(config, claims, lose, reject)
        output = io.StringIO()
        status = 0
        with tempfile.TemporaryDirectory() as directory:
            env["GITHUB_STEP_SUMMARY"] = str(Path(directory) / "summary")
            with (
                patch.dict(os.environ, env, clear=True),
                patch("urllib.request.build_opener", return_value=provider),
                contextlib.redirect_stdout(output),
                contextlib.redirect_stderr(output),
            ):
                try:
                    runpy.run_path(str(SCRIPT), run_name="__main__")
                except SystemExit as error:
                    status = error.code
            summary = Path(env["GITHUB_STEP_SUMMARY"])
            published = output.getvalue() + (
                summary.read_text() if summary.exists() else ""
            )
        for secret in [
            "private-source-value",
            "multiline-private-key",
            "provider-write-credential",
            "oidc-credential",
        ]:
            self.assertNotIn(secret, published)
        return status, published, provider, env

    def test_copy_both_scopes_preserves_exact_values_and_unrelated_entries(self):
        for config, count in [("dev", 14), ("prd", 22)]:
            with self.subTest(config=config):
                status, output, provider, env = self.invoke(config)
                self.assertEqual(status, 0, output)
                receipt = json.loads(
                    output.split("MIGRATION_RECEIPT=", 1)[1].splitlines()[0]
                )
                self.assertEqual(len(receipt["verifiedKeys"]), count)
                self.assertEqual(
                    provider.secrets["UNRELATED"]["raw"], "retain-existing"
                )
                for key in receipt["verifiedKeys"]:
                    source = "OKOU_" + key if key.startswith("GITHUB_APP_") else key
                    self.assertEqual(
                        provider.secrets[key]["computed"], env["SOURCE_" + source]
                    )

    def test_uncertain_write_is_verified_without_replaying(self):
        status, output, provider, _ = self.invoke("prd", lose=True)
        self.assertEqual(status, 0, output)
        self.assertEqual(len(provider.payloads), 1)
        self.assertIn('"unconfirmedWriteResponseRecovered":true', output)

    def test_wrong_commit_or_missing_source_prevents_writes(self):
        for changes in [
            {"EXPECTED_COMMIT": "b" * 40},
            {"SOURCE_SLACK_SIGNING_SECRET": ""},
        ]:
            status, _, provider, _ = self.invoke("dev", changes)
            self.assertEqual(status, 1)
            self.assertEqual(provider.payloads, [])

    def test_rejected_write_fails_without_exposing_provider_diagnostics(self):
        status, output, provider, _ = self.invoke("prd", reject=True)
        self.assertEqual(status, 1)
        self.assertIn("secret_verification_failed", output)
        self.assertEqual(len(provider.payloads), 1)


if __name__ == "__main__":
    unittest.main()
