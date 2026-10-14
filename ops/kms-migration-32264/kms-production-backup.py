#!/usr/bin/env python3
"""Escrow effective production KMS configuration without changing deployments."""

import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.parse
from pathlib import Path


PROJECT = "vm0-kms-rollback-32264"
CONFIG = "prd"
BACKUP_SECRET = "KMS_BACKUP_JSON"
IDENTITY = "c0c87790-e651-45dd-b7fa-c5ed07bb990f"
SOURCE_ACCOUNT = "072707626411"
SOURCE_KEY = (
    "arn:aws:kms:us-west-2:072707626411:key/a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8"
)
PRINCIPAL = f"arn:aws:iam::{SOURCE_ACCOUNT}:user/vm0-kms-prod"
VERCEL_PROJECT = "prj_6mw0CgYjECVrJV57VJ47VN03B4UR"
VERCEL_TEAM = "team_WRqI0kCoX5KcRInRWgZ1nBF0"
# GitHub keeps this numeric identity stable across owner and repository renames.
OKOU_REPOSITORY_ID = "1096175506"


class BackupError(Exception):
    """Only fixed, non-sensitive failure codes may reach workflow logs."""


def require(condition, code):
    if not condition:
        raise BackupError(code)


def required_env(name):
    value = os.environ.get(name, "")
    require(bool(value), "missing_required_environment")
    return value


def request_json(url, bearer=None, body=None):
    # Response bodies can contain credentials, even on a provider error.
    # Keep both output streams in memory and never relay provider diagnostics.
    command = [
        "curl",
        "--silent",
        "--show-error",
        "--max-time",
        "30",
        "--request",
        "POST" if body is not None else "GET",
        "--header",
        "Accept: application/json",
        "--write-out",
        "\n%{http_code}",
        url,
    ]
    if bearer is not None:
        command.extend(["--header", "Authorization: Bearer " + bearer])
    if body is not None:
        command.extend(
            ["--header", "Content-Type: application/json", "--data-binary", "@-"]
        )
    result = subprocess.run(
        command,
        input=None if body is None else json.dumps(body),
        text=True,
        capture_output=True,
        timeout=45,
        check=False,
    )
    require(result.returncode == 0, "provider_transport_failed")
    payload, status = result.stdout.rsplit("\n", 1)
    require(status.startswith("2"), "provider_request_rejected")
    response = json.loads(payload)
    require(isinstance(response, dict), "invalid_provider_response")
    require(response.get("success") is not False, "provider_operation_failed")
    return response


def aws(*arguments):
    result = subprocess.run(
        ["aws", *arguments, "--region", "us-west-2", "--output", "json"],
        text=True,
        capture_output=True,
        timeout=45,
        check=False,
    )
    require(result.returncode == 0, "source_aws_verification_failed")
    return json.loads(result.stdout)


def production_deployment(token, expected):
    project = request_json(
        f"https://api.vercel.com/v9/projects/{VERCEL_PROJECT}?teamId={VERCEL_TEAM}",
        token,
    )
    require(
        project["id"] == VERCEL_PROJECT and project["accountId"] == VERCEL_TEAM,
        "vercel_scope_mismatch",
    )
    deployment = project["targets"]["production"]
    require(deployment["id"] == expected, "production_deployment_changed")
    require(
        deployment["readyState"] == "READY" and deployment["target"] == "production",
        "production_deployment_not_ready",
    )
    require("api.okou.ai" in deployment["alias"], "production_alias_missing")
    commit = deployment["meta"]["githubCommitSha"]
    require(re.fullmatch(r"[0-9a-f]{40}", commit), "invalid_deployment_commit")
    return {"id": deployment["id"], "url": deployment["url"], "commit": commit}


def main():
    repository = required_env("GITHUB_REPOSITORY")
    require(
        required_env("GITHUB_REPOSITORY_ID") == OKOU_REPOSITORY_ID,
        "repository_scope_mismatch",
    )
    require(required_env("GITHUB_REF") == "refs/heads/main", "main_branch_required")
    require(
        required_env("GITHUB_EVENT_NAME") == "workflow_dispatch",
        "manual_dispatch_required",
    )
    require(
        required_env("GITHUB_WORKFLOW_REF")
        == f"{repository}/.github/workflows/kms-production-backup.yml@refs/heads/main",
        "workflow_scope_mismatch",
    )
    require(
        required_env("DOPPLER_SERVICE_IDENTITY_ID") == IDENTITY,
        "production_oidc_identity_required",
    )
    expected = required_env("EXPECTED_DEPLOYMENT_ID")
    require(re.fullmatch(r"dpl_[A-Za-z0-9]+", expected), "invalid_expected_deployment")
    run_id = required_env("GITHUB_RUN_ID")
    commit = required_env("GITHUB_SHA")
    require(
        run_id.isdigit() and re.fullmatch(r"[0-9a-f]{40}", commit),
        "invalid_workflow_metadata",
    )
    values = {
        name: required_env(name)
        for name in [
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "SECRETS_KMS_KEY_ID",
            "AWS_REGION",
        ]
    }
    require(
        values["AWS_REGION"] == "us-west-2" and not os.environ.get("AWS_SESSION_TOKEN"),
        "static_production_credentials_required",
    )
    require(
        values["SECRETS_KMS_KEY_ID"]
        in [
            SOURCE_KEY,
            SOURCE_KEY.rsplit("/", 1)[1],
            "alias/vm0-secrets-prod",
            f"arn:aws:kms:us-west-2:{SOURCE_ACCOUNT}:alias/vm0-secrets-prod",
        ],
        "source_key_required",
    )
    caller = aws("sts", "get-caller-identity")
    require(
        caller["Account"] == SOURCE_ACCOUNT and caller["Arn"] == PRINCIPAL,
        "source_principal_mismatch",
    )
    # The CLI only returns KeyId; its generated plaintext data key is never emitted.
    resolved_key = aws(
        "kms",
        "generate-data-key",
        "--key-id",
        values["SECRETS_KMS_KEY_ID"],
        "--key-spec",
        "AES_256",
        "--encryption-context",
        "purpose=vm0-stored-secret",
        "--query",
        "KeyId",
    )
    require(resolved_key == SOURCE_KEY, "resolved_source_key_mismatch")
    vercel_token = required_env("VERCEL_TOKEN")
    deployment = production_deployment(vercel_token, expected)
    request_url = urllib.parse.urlsplit(required_env("ACTIONS_ID_TOKEN_REQUEST_URL"))
    require(
        request_url.scheme == "https"
        and request_url.hostname.endswith(".actions.githubusercontent.com"),
        "invalid_oidc_origin",
    )
    query = dict(urllib.parse.parse_qsl(request_url.query))
    query["audience"] = "https://github.com/" + repository.partition("/")[0]
    oidc_url = urllib.parse.urlunsplit(
        request_url._replace(query=urllib.parse.urlencode(query))
    )
    oidc = request_json(oidc_url, required_env("ACTIONS_ID_TOKEN_REQUEST_TOKEN"))[
        "value"
    ]
    token = request_json(
        "https://api.doppler.com/v3/auth/oidc",
        body={"identity": IDENTITY, "token": oidc},
    )["token"]
    secrets_url = f"https://api.doppler.com/v3/configs/config/secrets?project={PROJECT}&config={CONFIG}&include_managed_secrets=false"
    require(
        request_json(secrets_url, token)["secrets"] == {},
        "backup_destination_not_empty",
    )
    require(
        production_deployment(vercel_token, expected) == deployment,
        "production_deployment_changed",
    )
    snapshot = json.dumps(
        {
            "version": 1,
            "capturedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "sourcePrincipal": PRINCIPAL,
            "sourceKeyArn": SOURCE_KEY,
            "configuration": values,
            "deployment": deployment,
            "workflow": {"repository": repository, "commit": commit, "runId": run_id},
        },
        separators=(",", ":"),
    )
    request_json(
        "https://api.doppler.com/v3/configs/config/secrets",
        token,
        {
            "project": PROJECT,
            "config": CONFIG,
            "change_requests": [
                {
                    "name": BACKUP_SECRET,
                    "originalName": None,
                    "originalValue": None,
                    "value": snapshot,
                    "visibility": "masked",
                }
            ],
        },
    )
    stored = request_json(secrets_url, token)["secrets"]
    require(set(stored) == {BACKUP_SECRET}, "backup_secret_set_mismatch")
    require(
        stored[BACKUP_SECRET]["raw"] == snapshot
        and stored[BACKUP_SECRET]["computed"] == snapshot,
        "backup_readback_mismatch",
    )
    require(
        stored[BACKUP_SECRET]["rawVisibility"] == "masked"
        and stored[BACKUP_SECRET]["computedVisibility"] == "masked",
        "backup_visibility_mismatch",
    )
    report = {
        "result": "passed",
        "backupProject": PROJECT,
        "backupConfig": CONFIG,
        "backupSecret": BACKUP_SECRET,
        "sourcePrincipal": PRINCIPAL,
        "sourceKeyArn": SOURCE_KEY,
        "configurationNames": sorted(values),
        "deployment": deployment,
        "runId": run_id,
        "readbackVerified": True,
        "snapshotSha256": hashlib.sha256(snapshot.encode()).hexdigest(),
        "productionConfigurationChanged": False,
    }
    report_path = Path(required_env("RUNNER_TEMP")) / "kms-production-backup.json"
    with report_path.open("x", encoding="utf-8") as output:
        os.chmod(report_path, 0o600)
        json.dump(report, output, indent=2)
        output.write("\n")
    print(json.dumps(report))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, BackupError) else "unexpected_error"
        print("Production KMS backup failed: " + code, file=sys.stderr)
        sys.exit(1)
