#!/usr/bin/env python3
"""Archive retired GitHub integration secrets in an isolated Doppler config.

Manual main-branch Actions only. Values stay in memory, provider errors are
redacted, and an uncertain write is verified rather than retried. Stdout and the
Actions summary contain only variable names and verification metadata.
"""

import base64
import hmac
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PROJECT = "vm0"
REPOSITORY = "okou-ai/okou"
REPOSITORY_ID = "1096175506"
WORKFLOW = (
    f"{REPOSITORY}/.github/workflows/archive-integration-secrets.yml@refs/heads/main"
)
API = "https://api.doppler.com/v3"
SOURCE_KEYS = (
    "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
    "DISCORD_OAUTH_CLIENT_SECRET",
    "WIX_OAUTH_CLIENT_SECRET",
    "VM0_GITHUB_APP_CLIENT_SECRET",
    "VM0_GITHUB_APP_PRIVATE_KEY",
    "VM0_GITHUB_APP_WEBHOOK_SECRET",
)
PRODUCTION_ONLY = set(SOURCE_KEYS) - {"GOOGLE_ADS_LOGIN_CUSTOMER_ID"}


class MigrationError(Exception):
    """Only fixed codes may reach the caller; never include provider bodies."""


def require(condition, code):
    if not condition:
        raise MigrationError(code)


def request_json(url, bearer=None, body=None):
    headers = {"Accept": "application/json"}
    if bearer:
        headers["Authorization"] = "Bearer " + bearer
    payload = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        payload = json.dumps(body).encode()
    request = urllib.request.Request(url, data=payload, headers=headers)

    # Authentication material must never follow a provider redirect.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    try:
        with urllib.request.build_opener(NoRedirect()).open(
            request, timeout=30
        ) as response:
            data = json.load(response)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        raise MigrationError("provider_request_failed") from None
    require(isinstance(data, dict), "invalid_provider_response")
    require(data.get("success") is not False, "provider_operation_failed")
    return data


def config_secrets(config, token):
    query = urllib.parse.urlencode({"project": PROJECT, "config": config})
    data = request_json(f"{API}/configs/config/secrets?{query}", token)
    require(isinstance(data.get("secrets"), dict), "invalid_secret_response")
    return data["secrets"]


def main():
    config = os.environ.get("MIGRATION_CONFIG", "")
    require(config in ("dev", "prd"), "invalid_environment")
    require(os.environ.get("GITHUB_REPOSITORY_ID") == REPOSITORY_ID, "wrong_repository")
    require(os.environ.get("GITHUB_REPOSITORY") == REPOSITORY, "wrong_repository")
    require(
        os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch",
        "manual_dispatch_required",
    )
    require(os.environ.get("GITHUB_REF") == "refs/heads/main", "main_branch_required")
    require(os.environ.get("GITHUB_WORKFLOW_REF") == WORKFLOW, "wrong_workflow")
    require(
        os.environ.get("EXPECTED_COMMIT") == os.environ.get("GITHUB_SHA")
        and len(os.environ.get("EXPECTED_COMMIT", "")) == 40,
        "source_commit_changed",
    )
    require(bool(os.environ.get("DOPPLER_WRITE_IDENTITY")), "missing_write_identity")

    expected = set(SOURCE_KEYS) - (PRODUCTION_ONLY if config == "dev" else set())
    sources = {key: os.environ.get("SOURCE_" + key, "") for key in SOURCE_KEYS}
    require(
        {key for key, value in sources.items() if value} == expected,
        "source_secret_set_changed",
    )
    values = {
        "LEGACY_GITHUB_" + key: sources[key] for key in SOURCE_KEYS if key in expected
    }
    # These are literal existing credentials, not Doppler reference expressions.
    require(
        not any("${" in value for value in values.values()),
        "unexpected_secret_reference",
    )

    oidc_url = urllib.parse.urlsplit(os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL", ""))
    require(
        oidc_url.scheme == "https"
        and bool(oidc_url.hostname)
        and oidc_url.hostname.endswith(".actions.githubusercontent.com"),
        "invalid_oidc_origin",
    )
    query = dict(urllib.parse.parse_qsl(oidc_url.query))
    query["audience"] = "https://github.com/okou-ai"
    oidc_url = urllib.parse.urlunsplit(
        oidc_url._replace(query=urllib.parse.urlencode(query))
    )
    oidc = request_json(
        oidc_url, os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "")
    ).get("value")
    require(isinstance(oidc, str), "missing_oidc_token")
    try:
        segment = oidc.split(".")[1]
        claims = json.loads(
            base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))
        )
    except (IndexError, ValueError):
        raise MigrationError("invalid_oidc_claims") from None
    require(
        claims.get("repository_id") == REPOSITORY_ID
        and claims.get("workflow_ref") == WORKFLOW
        and claims.get("sha") == os.environ["GITHUB_SHA"],
        "oidc_scope_mismatch",
    )
    if config == "prd":
        require(
            claims.get("environment") == "production", "production_environment_required"
        )
    else:
        require(not claims.get("environment"), "development_environment_mismatch")
    token = request_json(
        f"{API}/auth/oidc",
        body={"identity": os.environ["DOPPLER_WRITE_IDENTITY"], "token": oidc},
    ).get("token")
    require(isinstance(token, str) and bool(token), "missing_doppler_token")

    archive = config + "_github_integration_legacy"
    before = config_secrets(archive, token)
    require(
        all(
            key not in before
            or (
                before[key].get("raw") == value and before[key].get("computed") == value
            )
            for key, value in values.items()
        ),
        "archive_value_conflict",
    )
    changes = {key: value for key, value in values.items() if key not in before}
    uncertain = False
    if changes:
        try:
            request_json(
                f"{API}/configs/config/secrets",
                token,
                {"project": PROJECT, "config": archive, "secrets": changes},
            )
        except MigrationError:
            # The server may have committed the update. One read establishes
            # outcome; never resend a potentially completed write.
            uncertain = True
    after = config_secrets(archive, token)
    require(
        all(
            isinstance(after.get(key, {}).get("computed"), str)
            and hmac.compare_digest(after[key]["computed"].encode(), value.encode())
            and hmac.compare_digest(after[key]["raw"].encode(), value.encode())
            for key, value in values.items()
        ),
        "secret_verification_failed",
    )
    require(
        all(
            key in after and after[key].get("raw") == value.get("raw")
            for key, value in before.items()
            if key not in changes
        ),
        "unrelated_secret_changed",
    )
    receipt = {
        "project": PROJECT,
        "config": archive,
        "sourceEnvironment": config,
        "commit": os.environ["GITHUB_SHA"],
        "runId": os.environ["GITHUB_RUN_ID"],
        "verifiedKeys": sorted(values),
        "writtenKeys": sorted(changes),
        "unconfirmedWriteResponseRecovered": uncertain,
    }
    print("MIGRATION_RECEIPT=" + json.dumps(receipt, separators=(",", ":")))
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        Path(summary).write_text(
            f"Verified {len(values)} retired integration secrets in `{PROJECT}/{archive}`. Values were not logged.\n\n"
            + "\n".join(f"- `{key}`" for key in sorted(values))
            + "\n"
        )


if __name__ == "__main__":
    try:
        main()
    except (MigrationError, KeyError, TypeError, ValueError) as error:
        code = (
            str(error)
            if isinstance(error, MigrationError)
            else "invalid_migration_response"
        )
        print("Integration secret migration failed: " + code, file=sys.stderr)
        raise SystemExit(1) from None
