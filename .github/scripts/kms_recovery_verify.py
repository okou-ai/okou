"""Target-only KMS verification for an already isolated snapshot connection."""

import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.parse
from pathlib import Path

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

    def __init__(self, code, diagnostics=None):
        super().__init__(code)
        self.diagnostics = diagnostics


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
            check=False,
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
        check=False,
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


COUNT_NAMES = {
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

FAILURE_STAGES = {
    "connect",
    "session",
    "storage_manifest",
    "read_batch",
    "process_rows",
}
FAILURE_CODES = {
    "storage_manifest_mismatch",
    "primary_key_manifest_mismatch",
    "untracked_encrypted_columns",
    "unknown_queue_payload_version",
    "unexpected_key_reference",
    "unexpected_decrypt_response",
    "invalid_data_key_size",
    "invalid_object",
    "invalid_string",
    "invalid_base64",
    "invalid_envelope_prefix",
    "invalid_envelope_encoding",
    "invalid_envelope_shape",
    "invalid_data_key",
    "invalid_direct_ciphertext",
    "invalid_ciphertext_blocks_migration",
    "AccessDeniedException",
    "InvalidCiphertextException",
    "IncorrectKeyException",
    "DisabledException",
    "NotFoundException",
    "KMSInvalidStateException",
    "ThrottlingException",
    "DependencyTimeoutException",
    "ExpiredTokenException",
    "CredentialsProviderError",
    "TimeoutError",
    "SyntaxError",
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "CERT_HAS_EXPIRED",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "08006",
    "28P01",
    "3D000",
    "42501",
    "42703",
    "42P01",
    "57014",
    "53300",
    "55P03",
    "40001",
    "40P01",
    "unclassified_error",
}


def failure_report(path, database):
    # Rebuild an allowlisted record. Never retain cursor contents or field keys.
    try:
        if not path.is_file():
            return {"reportStatus": "missing"}
        if path.stat().st_size >= 1000000:
            return {"reportStatus": "too_large"}
        report = json.loads(path.read_bytes())
    except (ValueError, UnicodeError):
        return {"reportStatus": "invalid_json"}
    except OSError:
        return {"reportStatus": "unreadable"}
    if not isinstance(report, dict) or not (
        report.get("mode") == "verify"
        and report.get("source") == SOURCE
        and report.get("target") == TARGET
        and report.get("database") == database
        and isinstance(report.get("manifest"), str)
        and re.fullmatch(r"[0-9a-f]{64}", report["manifest"])
    ):
        return {"reportStatus": "invalid_binding"}
    totals = report.get("totals")
    if not (
        isinstance(totals, dict)
        and set(totals) == COUNT_NAMES
        and all(type(v) is int and v >= 0 for v in totals.values())
        and all(
            type(report.get(k)) is bool
            for k in ("complete", "resumed", "databaseVerifiedOnTarget")
        )
    ):
        return {"reportStatus": "invalid_shape"}
    safe = {
        "reportStatus": "validated",
        "database": database,
        "manifest": report["manifest"],
        "complete": report["complete"],
        "resumed": report["resumed"],
        "databaseVerifiedOnTarget": report["databaseVerifiedOnTarget"],
        "cursorPresent": report.get("cursor") is not None,
        "failure": report.get("failure")
        if report.get("failure") in (None, "migration_failed_at_cursor")
        else "unclassified_error",
        "totals": totals,
    }
    details = report.get("failureDetails")
    if isinstance(details, dict):
        stage, code = details.get("stage"), details.get("code")
        if (
            isinstance(stage, str)
            and stage in FAILURE_STAGES
            and isinstance(code, str)
            and code in FAILURE_CODES
        ):
            safe["failureDetails"] = {"stage": stage, "code": code}
    return safe


def process_failure(path, database, result, seconds):
    # Output is private. Only recognize fixed loader codes, never print matches.
    output = b"\n".join(
        value.encode() if isinstance(value, str) else value or b""
        for value in (result.stdout, result.stderr)
    )
    loader_codes = [
        code
        for code in (
            "ERR_MODULE_NOT_FOUND",
            "MODULE_NOT_FOUND",
            "ERR_PACKAGE_PATH_NOT_EXPORTED",
            "ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL",
            "ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND",
            "ERR_PNPM_BAD_PM_VERSION",
        )
        if re.search(rb"(?<![A-Z_])" + code.encode() + rb"(?![A-Z_])", output)
    ]
    return {
        "exitCode": None
        if isinstance(result, subprocess.TimeoutExpired)
        else result.returncode,
        "processTimeoutSeconds": seconds
        if isinstance(result, subprocess.TimeoutExpired)
        else None,
        "loaderCodes": loader_codes,
        "toolReport": failure_report(path, database),
    }


def verify_database(parsed, environment, deadline):
    # The caller has validated this exact preview host, database, role and branch.
    query = {"sslmode": "verify-full"}
    uri = urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(query)))
    scoped = {**environment, "DATABASE_URL": uri}
    seconds = min(5400, int(deadline - time.monotonic()))
    require(seconds > 0, "recovery_verification_time_budget_exhausted")
    root = Path(__file__).resolve().parents[2]
    database = hashlib.sha256(
        f"{parsed.netloc.split('@')[-1]}{parsed.path}:{parsed.username}".encode()
    ).hexdigest()
    with tempfile.TemporaryDirectory(prefix="kms-recovery-verification-") as directory:
        report_path = Path(directory) / "verification.json"
        try:
            result = subprocess.run(
                [
                    "pnpm",
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
                # Corepack resolves packageManager before pnpm parses --dir.
                # Start inside the workspace that installed the locked tool.
                cwd=root / "turbo/packages/db",
                env=scoped,
                check=False,
                capture_output=True,
                text=False,
                timeout=seconds,
            )
        except subprocess.TimeoutExpired as error:
            raise RecoveryVerificationError(
                "target_recovery_verification_process_timeout",
                process_failure(report_path, database, error, seconds),
            ) from None
        if result.returncode != 0 or not report_path.is_file():
            raise RecoveryVerificationError(
                "target_recovery_verification_failed",
                process_failure(report_path, database, result, seconds),
            )
        try:
            require(
                report_path.stat().st_size < 1000000,
                "recovery_verification_report_too_large",
            )
            report = json.loads(report_path.read_bytes())
            require(isinstance(report, dict), "invalid_recovery_verification_report")
            return validated_report(report, database)
        except (
            RecoveryVerificationError,
            KeyError,
            ValueError,
            TypeError,
            OSError,
        ) as error:
            raise RecoveryVerificationError(
                str(error)
                if isinstance(error, RecoveryVerificationError)
                else "invalid_recovery_verification_report",
                process_failure(report_path, database, result, seconds),
            ) from None


def validated_report(report, database):
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
    require(
        isinstance(totals, dict)
        and set(totals) == COUNT_NAMES
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
