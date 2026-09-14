"""Target-only KMS verification for an already isolated snapshot connection."""

import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.parse

SOURCE = "arn:aws:kms:us-west-2:072707626411:key/a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8"
TARGET = "arn:aws:kms:us-west-2:251964670836:key/e68917e2-5541-4597-b6ef-7e9eb5670947"
ROLE = "arn:aws:iam::251964670836:role/vm0-kms-migration-github-32264"
POLICY = {
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": "kms:Decrypt",
            "Resource": TARGET,
            "Condition": {
                "StringEquals": {"kms:EncryptionContext:purpose": "vm0-stored-secret"}
            },
        },
        {"Effect": "Deny", "Action": "kms:*", "NotResource": TARGET},
        {
            "Effect": "Deny",
            "NotAction": ["kms:Decrypt", "sts:GetCallerIdentity"],
            "Resource": "*",
        },
    ],
}


class RecoveryVerificationError(Exception):
    """Fixed codes only; provider, database and secret values stay private."""


def require(condition, code):
    if not condition:
        raise RecoveryVerificationError(code)


def aws(operation, environment, payload=None):
    # The CLI rereads input: use an anonymous seekable file, never token argv.
    with os.fdopen(os.memfd_create("kms-recovery-sts"), "w+") as request:
        command = ["aws", "sts", operation, "--region", "us-west-2", "--output", "json"]
        if payload is not None:
            json.dump(payload, request)
            request.flush()
            command += ["--cli-input-json", f"file:///proc/self/fd/{request.fileno()}"]
        result = subprocess.run(
            command,
            pass_fds=(request.fileno(),),
            env=environment,
            capture_output=True,
            text=True,
            timeout=45,
        )
    if result.returncode != 0:
        match = re.search(r"An error occurred \(([A-Za-z0-9]+)\)", result.stderr)
        code = (
            match[1]
            if match
            and match[1]
            in {
                "AccessDenied",
                "AccessDeniedException",
                "ExpiredToken",
                "InvalidIdentityToken",
                "IDPRejectedClaim",
                "ValidationError",
                "MalformedPolicyDocument",
                "PackedPolicyTooLarge",
                "Throttling",
            }
            else "UnclassifiedAwsCliFailure"
        )
        raise RecoveryVerificationError("recovery_sts_" + operation + ":" + code)
    return json.loads(result.stdout)


def target_session():
    require(os.environ.get("KMS_MIGRATION_ROLE_ARN") == ROLE, "wrong_recovery_role")
    url = urllib.parse.urlsplit(os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"])
    require(
        url.scheme == "https"
        and url.hostname
        and url.hostname.endswith(".actions.githubusercontent.com"),
        "invalid_recovery_oidc_origin",
    )
    query = dict(urllib.parse.parse_qsl(url.query))
    query["audience"] = "sts.amazonaws.com"
    response = subprocess.run(
        [
            "curl",
            "--silent",
            "--show-error",
            "--max-time",
            "30",
            "--max-filesize",
            "65536",
            "--proto",
            "=https",
            "--header",
            "Authorization: Bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"],
            "--write-out",
            "\n%{http_code}",
            urllib.parse.urlunsplit(url._replace(query=urllib.parse.urlencode(query))),
        ],
        capture_output=True,
        text=True,
        timeout=35,
    )
    require(response.returncode == 0, "recovery_oidc_transport_failed")
    body, status = response.stdout.rsplit("\n", 1)
    require(status == "200", "recovery_oidc_rejected")
    token = json.loads(body)["value"]
    require(isinstance(token, str) and token, "recovery_oidc_token_missing")
    environment = {
        k: v
        for k, v in os.environ.items()
        if k in {"PATH", "HOME", "CI", "PNPM_HOME", "COREPACK_HOME", "npm_config_audit"}
    }
    environment.update(
        {
            "AWS_REGION": "us-west-2",
            "AWS_DEFAULT_REGION": "us-west-2",
            "AWS_EC2_METADATA_DISABLED": "true",
            "AWS_CONFIG_FILE": "/dev/null",
            "AWS_SHARED_CREDENTIALS_FILE": "/dev/null",
        }
    )
    name = "kms-recovery-" + os.environ["GITHUB_RUN_ID"]
    result = aws(
        "assume-role-with-web-identity",
        environment,
        {
            "RoleArn": ROLE,
            "RoleSessionName": name,
            "WebIdentityToken": token,
            "DurationSeconds": 7200,
            "Policy": json.dumps(POLICY, separators=(",", ":")),
        },
    )
    credentials = result["Credentials"]
    expiration = dt.datetime.fromisoformat(
        credentials["Expiration"].replace("Z", "+00:00")
    )
    require(
        expiration.tzinfo is not None
        and (expiration - dt.datetime.now(dt.timezone.utc)).total_seconds() >= 6000,
        "recovery_session_too_short",
    )
    for name, source in [
        ("AWS_ACCESS_KEY_ID", "AccessKeyId"),
        ("AWS_SECRET_ACCESS_KEY", "SecretAccessKey"),
        ("AWS_SESSION_TOKEN", "SessionToken"),
    ]:
        value = credentials[source]
        require(isinstance(value, str) and value, "recovery_credentials_missing")
        environment[name] = value
    identity = aws("get-caller-identity", environment)
    expected = (
        "arn:aws:sts::251964670836:assumed-role/vm0-kms-migration-github-32264/kms-recovery-"
        + os.environ["GITHUB_RUN_ID"]
    )
    require(
        identity.get("Account") == "251964670836" and identity.get("Arn") == expected,
        "recovery_identity_mismatch",
    )
    return environment, {
        "principal": expected,
        "sessionPolicySha256": hashlib.sha256(
            json.dumps(POLICY, sort_keys=True).encode()
        ).hexdigest(),
        "onlyTargetDecryptAllowed": True,
        "expiration": expiration.isoformat(),
    }


def verify_database(parsed, environment, deadline):
    # The caller has validated this exact preview host, database, role and branch.
    query = {"sslmode": "verify-full"}
    uri = urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(query)))
    scoped = {**environment, "DATABASE_URL": uri}
    seconds = min(5400, int(deadline - time.monotonic()))
    require(seconds > 0, "recovery_verification_time_budget_exhausted")
    root = Path(__file__).resolve().parents[2]
    with tempfile.TemporaryDirectory(prefix="kms-recovery-verification-") as directory:
        report_path = Path(directory) / "verification.json"
        result = subprocess.run(
            [
                "pnpm",
                "--dir",
                "turbo/packages/db",
                "exec",
                "tsx",
                "scripts/migrations/013-kms-account-rotation/backfill.ts",
                "--source-key",
                SOURCE,
                "--target-key",
                TARGET,
                "--verify",
                "--verify-concurrency",
                "8",
                "--batch-size",
                "100",
                "--max-rows",
                "1000000",
                "--report-path",
                str(report_path),
            ],
            cwd=root,
            env=scoped,
            capture_output=True,
            text=True,
            timeout=seconds,
        )
        require(
            result.returncode == 0 and report_path.is_file(),
            "target_recovery_verification_failed",
        )
        require(
            report_path.stat().st_size < 1000000,
            "recovery_verification_report_too_large",
        )
        report = json.loads(report_path.read_text())
    database = hashlib.sha256(
        f"{parsed.netloc.split('@')[-1]}{parsed.path}:{parsed.username}".encode()
    ).hexdigest()
    require(
        report.get("mode") == "verify"
        and report.get("source") == SOURCE
        and report.get("target") == TARGET
        and report.get("database") == database
        and report.get("complete") is True
        and report.get("resumed") is False
        and report.get("databaseVerifiedOnTarget") is True
        and report.get("failure") is None
        and report.get("cursor") is None,
        "target_recovery_verification_incomplete",
    )
    totals = report["totals"]
    names = {
        "rows",
        "envelope",
        "direct",
        "source",
        "target",
        "nonArn",
        "invalid",
        "unknownKey",
        "nestedUninspected",
        "nestedSource",
        "nestedTarget",
        "verified",
        "updated",
        "concurrentChanges",
    }
    require(
        set(totals) == names
        and all(type(v) is int and v >= 0 for v in totals.values()),
        "invalid_recovery_verification_totals",
    )
    require(
        totals["rows"] > 0
        and all(
            totals[k] == 0
            for k in [
                "source",
                "nestedSource",
                "nestedUninspected",
                "nonArn",
                "invalid",
                "unknownKey",
                "updated",
                "concurrentChanges",
            ]
        )
        and totals["rows"] == totals["verified"] == totals["target"]
        and totals["rows"] == totals["envelope"] + totals["direct"],
        "target_recovery_ciphertext_not_verified",
    )
    manifest = report["manifest"]
    require(
        isinstance(manifest, str) and re.fullmatch(r"[0-9a-f]{64}", manifest),
        "invalid_recovery_manifest",
    )
    return {
        "database": database,
        "manifest": manifest,
        "totals": totals,
        "verifiedOnTarget": True,
    }
