#!/usr/bin/env python3
"""Run protected production KMS verification or a bounded ciphertext migration."""

from contextlib import ExitStack
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.parse

from kms_recovery_verify import (
    RecoveryVerificationError,
    target_session,
    verify_database,
)


SOURCE = "arn:aws:kms:us-west-2:072707626411:key/a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8"
TARGET = "arn:aws:kms:us-west-2:251964670836:key/e68917e2-5541-4597-b6ef-7e9eb5670947"
OPERATOR = "arn:aws:iam::251964670836:role/vm0-kms-migration-github-32264"
IDENTITY = "c0c87790-e651-45dd-b7fa-c5ed07bb990f"
VERCEL_PROJECT = "prj_6mw0CgYjECVrJV57VJ47VN03B4UR"
VERCEL_TEAM = "team_WRqI0kCoX5KcRInRWgZ1nBF0"
DB_PROJECT = "hidden-lab-39609750"
MIGRATION = "scripts/migrations/013-kms-account-rotation"
CONFIG_NAMES = {
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "SECRETS_KMS_KEY_ID",
    "AWS_REGION",
}


class MigrationError(Exception):
    """Only fixed failure codes may reach logs; provider bodies stay in memory."""


class AwsOperationError(MigrationError):
    """Retain only an allowlisted operation/error and the CLI exit status."""

    def __init__(self, operation, result):
        match = re.search(r"An error occurred \(([A-Za-z0-9]+)\)", result.stderr)
        error_code = "UnclassifiedAwsCliFailure"
        if match and match[1] in {
            "AccessDenied", "AccessDeniedException", "ExpiredToken",
            "ExpiredTokenException", "IDPCommunicationError", "IDPRejectedClaim",
            "InvalidClientTokenId", "InvalidIdentityToken", "MalformedPolicyDocument",
            "PackedPolicyTooLarge", "RegionDisabledException", "RequestExpired",
            "ServiceUnavailable", "SignatureDoesNotMatch", "Throttling",
            "ThrottlingException", "ValidationError",
        }:
            error_code = match[1]
        elif any(
            prefix in result.stderr
            for prefix in (
                "Error parsing parameter '--cli-input-json':",
                "Error parsing parameter 'cli-input-json':",
            )
        ):
            error_code = "CliInputError"
        elif "Parameter validation failed:" in result.stderr:
            error_code = "ParameterValidationFailed"
        elif "SSL validation failed" in result.stderr:
            error_code = "TlsValidationFailed"
        elif "Could not connect to the endpoint URL" in result.stderr:
            error_code = "EndpointConnectionFailed"
        elif "Unable to locate credentials" in result.stderr:
            error_code = "CredentialsUnavailable"
        self.details = {
            "operation": operation,
            "errorCode": error_code,
            "exitCode": result.returncode,
        }
        super().__init__("aws_operation_failed:" + operation + ":" + error_code)


def require(condition, code):
    if not condition:
        raise MigrationError(code)


def required_env(name):
    value = os.environ.get(name, "")
    require(bool(value), "missing_required_environment")
    return value


def request_json(url, bearer=None, body=None):
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
    value = json.loads(payload)
    require(
        isinstance(value, dict) and value.get("success") is not False,
        "invalid_provider_response",
    )
    return value


def oidc(audience):
    url = urllib.parse.urlsplit(required_env("ACTIONS_ID_TOKEN_REQUEST_URL"))
    require(
        url.scheme == "https"
        and url.hostname.endswith(".actions.githubusercontent.com"),
        "invalid_oidc_origin",
    )
    query = dict(urllib.parse.parse_qsl(url.query))
    query["audience"] = audience
    return request_json(
        urllib.parse.urlunsplit(url._replace(query=urllib.parse.urlencode(query))),
        required_env("ACTIONS_ID_TOKEN_REQUEST_TOKEN"),
    )["value"]


def aws(arguments, environment, payload=None):
    operation = {
        ("sts", "get-caller-identity"): "sts:GetCallerIdentity",
        ("sts", "assume-role-with-web-identity"): "sts:AssumeRoleWithWebIdentity",
        ("cloudtrail", "lookup-events"): "cloudtrail:LookupEvents",
    }[tuple(arguments[:2])]
    with ExitStack() as resources:
        descriptors = ()
        if payload is not None:
            # AWS CLI can read JSON input more than once. A pipe is consumed on
            # its first read; this anonymous Linux memory file is seekable and
            # keeps the OIDC token out of disk files and process arguments.
            input_file = resources.enter_context(
                os.fdopen(os.memfd_create("kms-migration-input"), "w+")
            )
            json.dump(payload, input_file)
            input_file.flush()
            descriptors = (input_file.fileno(),)
            arguments = [
                *arguments,
                "--cli-input-json",
                "file:///proc/self/fd/" + str(input_file.fileno()),
            ]
        result = subprocess.run(
            ["aws", *arguments, "--region", "us-west-2", "--output", "json"],
            pass_fds=descriptors,
            env=environment,
            text=True,
            capture_output=True,
            timeout=45,
            check=False,
        )
    if result.returncode != 0:
        raise AwsOperationError(operation, result)
    return json.loads(result.stdout)


def runtime_environment(configuration):
    require(set(configuration) == CONFIG_NAMES, "invalid_runtime_configuration")
    require(
        all(isinstance(value, str) and value for value in configuration.values()),
        "missing_runtime_configuration",
    )
    require(configuration["AWS_REGION"] == "us-west-2", "runtime_region_mismatch")
    # Do not propagate provider control-plane tokens into the KMS/DB subprocess.
    environment = {
        name: value
        for name, value in os.environ.items()
        if name
        in {
            "PATH",
            "HOME",
            "NODE_EXTRA_CA_CERTS",
            "CI",
            "PNPM_HOME",
            "COREPACK_HOME",
            "npm_config_audit",
        }
    }
    return {
        **environment,
        **configuration,
        "AWS_SESSION_TOKEN": "",
        "AWS_DEFAULT_REGION": "us-west-2",
        "AWS_EC2_METADATA_DISABLED": "true",
    }


def backup_configuration():
    require(
        required_env("DOPPLER_SERVICE_IDENTITY_ID") == IDENTITY,
        "wrong_production_doppler_identity",
    )
    token = request_json(
        "https://api.doppler.com/v3/auth/oidc",
        body={"identity": IDENTITY, "token": oidc("https://github.com/vm0-ai")},
    )["token"]
    secrets = request_json(
        "https://api.doppler.com/v3/configs/config/secrets?project=vm0-kms-rollback-32264&config=prd&include_managed_secrets=false",
        token,
    )["secrets"]
    require(set(secrets) == {"KMS_BACKUP_JSON"}, "backup_secret_set_changed")
    stored = secrets["KMS_BACKUP_JSON"]
    require(
        stored["raw"] == stored["computed"]
        and stored["rawVisibility"] == stored["computedVisibility"] == "masked",
        "backup_visibility_or_reference_changed",
    )
    require(
        hashlib.sha256(stored["raw"].encode()).hexdigest()
        == required_env("EXPECTED_BACKUP_SHA256"),
        "backup_digest_changed",
    )
    snapshot = json.loads(stored["raw"])
    require(
        snapshot["version"] == 1
        and snapshot["sourceKeyArn"] == SOURCE
        and snapshot["sourcePrincipal"]
        == "arn:aws:iam::072707626411:user/vm0-kms-prod",
        "backup_identity_mismatch",
    )
    require(
        snapshot["workflow"]
        == {
            "repository": "vm0-ai/vm0",
            "commit": "594d907ca844e845f674c04640a58ae8cebcdc8a",
            "runId": "34324494642",
        },
        "backup_provenance_mismatch",
    )
    return snapshot["configuration"]


def production_deployment(expected):
    project = request_json(
        f"https://api.vercel.com/v9/projects/{VERCEL_PROJECT}?teamId={VERCEL_TEAM}",
        required_env("VERCEL_TOKEN"),
    )
    require(
        project["id"] == VERCEL_PROJECT and project["accountId"] == VERCEL_TEAM,
        "deployment_project_mismatch",
    )
    deployment = project["targets"]["production"]
    require(
        deployment["id"] == expected
        and deployment["readyState"] == "READY"
        and deployment["target"] == "production"
        and "api.okou.ai" in deployment["alias"],
        "production_deployment_changed",
    )
    commit = deployment["meta"]["githubCommitSha"]
    require(re.fullmatch(r"[0-9a-f]{40}", commit), "invalid_deployment_commit")
    return {"id": deployment["id"], "url": deployment["url"], "commit": commit}


def database_url():
    require(required_env("NEON_PROJECT_ID") == DB_PROJECT, "database_project_mismatch")
    base = f"https://console.neon.tech/api/v2/projects/{DB_PROJECT}"
    token = required_env("NEON_API_KEY")
    branches = request_json(base + "/branches", token)["branches"]
    matches = [branch for branch in branches if branch["name"] == "production"]
    require(len(matches) == 1, "production_branch_not_unique")
    query = urllib.parse.urlencode(
        {
            "branch_id": matches[0]["id"],
            "database_name": "neondb",
            "role_name": "neondb_owner",
            "pooled": "false",
        }
    )
    parsed = urllib.parse.urlsplit(
        request_json(base + "/connection_uri?" + query, token)["uri"]
    )
    require(
        parsed.scheme in {"postgres", "postgresql"}
        and parsed.hostname
        and parsed.hostname.endswith(".neon.tech")
        and "-pooler" not in parsed.hostname
        and parsed.path == "/neondb"
        and parsed.username == "neondb_owner"
        and parsed.password,
        "invalid_production_database_uri",
    )
    parameters = dict(urllib.parse.parse_qsl(parsed.query))
    parameters["sslmode"] = "verify-full"
    uri = urllib.parse.urlunsplit(
        parsed._replace(query=urllib.parse.urlencode(parameters))
    )
    require("\r" not in uri and "\n" not in uri, "invalid_database_uri_delimiter")
    return uri


def run_tool(arguments, environment):
    # The subprocess emits only sanitized reports, but suppress both streams to
    # also contain dependency/SDK failure diagnostics. Checkpoints are retained.
    result = subprocess.run(
        ["pnpm", "exec", "tsx", *arguments],
        env=environment,
        text=True,
        capture_output=True,
        timeout=6000,
        check=False,
    )
    require(
        result.returncode == 0, "migration_tool_failed_inspect_sanitized_checkpoint"
    )


def canary(phase, environment, directory):
    identity = aws(["sts", "get-caller-identity"], environment)
    (directory / "identity.json").write_text(
        json.dumps({"Account": identity["Account"], "Arn": identity["Arn"]})
    )
    run_tool([MIGRATION + "/runtime-canary.ts", phase, str(directory)], environment)
    return identity["Arn"]


def assume_operator(environment):
    require(
        required_env("KMS_MIGRATION_ROLE_ARN") == OPERATOR,
        "migration_role_not_configured",
    )
    session_name = "github-kms-" + required_env("GITHUB_RUN_ID")
    response = aws(
        [
            "sts",
            "assume-role-with-web-identity",
        ],
        environment,
        {
            "RoleArn": OPERATOR,
            "RoleSessionName": session_name,
            "WebIdentityToken": oidc("sts.amazonaws.com"),
            "DurationSeconds": 7200,
        },
    )
    credentials = response["Credentials"]
    operator = {
        **environment,
        "AWS_ACCESS_KEY_ID": credentials["AccessKeyId"],
        "AWS_SECRET_ACCESS_KEY": credentials["SecretAccessKey"],
        "AWS_SESSION_TOKEN": credentials["SessionToken"],
    }
    identity = aws(["sts", "get-caller-identity"], operator)
    require(
        identity["Account"] == "251964670836"
        and identity["Arn"]
        == "arn:aws:sts::251964670836:assumed-role/vm0-kms-migration-github-32264/"
        + session_name,
        "migration_operator_identity_mismatch",
    )
    return operator


def read_verification(path):
    report = json.loads(path.read_text())
    require(
        report["mode"] == "verify"
        and report["complete"] is True
        and report["resumed"] is False
        and report["failure"] is None
        and report["cursor"] is None,
        "full_verification_required",
    )
    require(
        report["source"] == SOURCE and report["target"] == TARGET,
        "verification_key_scope_mismatch",
    )
    require(
        all(
            report["totals"][name] == 0
            for name in [
                "nonArn",
                "invalid",
                "unknownKey",
                "nestedUninspected",
                "updated",
                "concurrentChanges",
            ]
        ),
        "verification_has_unresolved_ciphertext",
    )
    require(
        report["totals"]["rows"] == report["totals"]["verified"],
        "verification_count_mismatch",
    )
    return report


def source_audit():
    """Read source-key event history without generating KMS canary calls."""
    output = Path(required_env("RUNNER_TEMP")) / "kms-production-reports"
    output.mkdir(mode=0o700)
    now = datetime.datetime.now(datetime.timezone.utc)
    start = datetime.datetime.fromisoformat(
        required_env("SOURCE_AUDIT_WINDOW_START").replace("Z", "+00:00")
    )
    end = now - datetime.timedelta(minutes=15)
    report = {
        "version": 1,
        "operation": "source-audit",
        "runId": required_env("GITHUB_RUN_ID"),
        "commit": required_env("GITHUB_SHA"),
        "startedAt": now.isoformat(),
        "sourceKeyArn": SOURCE,
        "account": "072707626411",
        "region": "us-west-2",
        "windowStart": start.isoformat(),
        "windowEnd": end.isoformat(),
        "visibilityBufferSeconds": 900,
        "lateArrivalExcluded": False,
        "backupSnapshotSha256": required_env("EXPECTED_BACKUP_SHA256"),
        "result": "running",
        "collectionComplete": False,
        "retirementCleared": False,
        "productionConfigurationChanged": False,
        "staticCredentialsCreated": False,
        "kmsCallsMade": False,
        "queries": [],
        "events": [],
    }
    try:
        require(
            start.utcoffset() == datetime.timedelta(0) and start < end < now,
            "invalid_audit_window",
        )
        # LookupEvents retains only 90 days. Never report a complete historical
        # window after its beginning falls outside that service boundary.
        require(now - start < datetime.timedelta(days=90), "audit_window_expired")
        environment = runtime_environment(backup_configuration())
        identity = aws(["sts", "get-caller-identity"], environment)
        require(
            identity.get("Account") == "072707626411"
            and identity.get("Arn") == "arn:aws:iam::072707626411:user/vm0-kms-prod",
            "source_audit_principal_mismatch",
        )
        report["sourcePrincipalVerified"] = True
        crypto = {
            "Decrypt",
            "Encrypt",
            "ReEncrypt",
            "GenerateDataKey",
            "GenerateDataKeyWithoutPlaintext",
            "GenerateDataKeyPair",
            "GenerateDataKeyPairWithoutPlaintext",
            "Sign",
            "Verify",
            "GenerateMac",
            "VerifyMac",
            "DeriveSharedSecret",
        }
        management = {
            "DescribeKey",
            "GetKeyPolicy",
            "GetKeyRotationStatus",
            "ListGrants",
            "ListKeyPolicies",
            "ListResourceTags",
            "CreateGrant",
            "RevokeGrant",
            "RetireGrant",
            "PutKeyPolicy",
            "EnableKey",
            "DisableKey",
            "ScheduleKeyDeletion",
            "CancelKeyDeletion",
            "EnableKeyRotation",
            "DisableKeyRotation",
            "TagResource",
            "UntagResource",
            "UpdateKeyDescription",
            "RotateKeyOnDemand",
            "ListKeyRotations",
        }
        seen = {}
        for resource in [SOURCE, SOURCE.rsplit("/", 1)[1]]:
            query = {
                "resourceForm": "arn" if resource == SOURCE else "key-id",
                "pages": 0,
                "returnedEvents": 0,
                "complete": False,
            }
            report["queries"].append(query)
            tokens = set()
            token = None
            for _ in range(100):
                # CloudTrail permits two LookupEvents requests per second.
                time.sleep(0.6)
                payload = {
                    "LookupAttributes": [
                        {"AttributeKey": "ResourceName", "AttributeValue": resource}
                    ],
                    "StartTime": start.isoformat(),
                    "EndTime": end.isoformat(),
                    "MaxResults": 50,
                }
                if token is not None:
                    payload["NextToken"] = token
                page = aws(
                    ["cloudtrail", "lookup-events", "--no-paginate"],
                    environment,
                    payload,
                )
                require(isinstance(page, dict), "invalid_audit_page")
                events = page.get("Events")
                require(
                    isinstance(events, list) and len(events) <= 50,
                    "invalid_audit_events",
                )
                query["pages"] += 1
                query["returnedEvents"] += len(events)
                for event in events:
                    require(isinstance(event, dict), "invalid_audit_event")
                    event_id = event.get("EventId", "")
                    require(
                        isinstance(event_id, str)
                        and re.fullmatch(
                            r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", event_id
                        ),
                        "invalid_audit_event_id",
                    )
                    raw = json.loads(event["CloudTrailEvent"])
                    require(
                        isinstance(raw, dict)
                        and raw.get("eventID") == event_id
                        and raw.get("eventSource") == "kms.amazonaws.com"
                        and raw.get("awsRegion") == "us-west-2"
                        and raw.get("recipientAccountId") == "072707626411",
                        "audit_event_scope_mismatch",
                    )
                    occurred = datetime.datetime.fromisoformat(
                        raw["eventTime"].replace("Z", "+00:00")
                    )
                    require(
                        occurred.utcoffset() == datetime.timedelta(0)
                        and start <= occurred <= end,
                        "audit_event_time_mismatch",
                    )
                    resources = event.get("Resources")
                    require(
                        isinstance(resources, list)
                        and any(
                            isinstance(value, dict)
                            and value.get("ResourceName")
                            in {SOURCE, SOURCE.rsplit("/", 1)[1]}
                            for value in resources
                        ),
                        "audit_resource_mismatch",
                    )
                    name = raw.get("eventName")
                    require(
                        isinstance(name, str) and name == event.get("EventName"),
                        "audit_event_name_mismatch",
                    )
                    principal = raw.get("userIdentity")
                    require(isinstance(principal, dict), "invalid_audit_identity")
                    digest = hashlib.sha256(
                        json.dumps(raw, sort_keys=True).encode()
                    ).hexdigest()
                    if event_id in seen:
                        require(seen[event_id] == digest, "audit_duplicate_changed")
                        continue
                    seen[event_id] = digest
                    report["events"].append(
                        {
                            "eventTime": occurred.isoformat(),
                            "eventName": name
                            if name in crypto | management
                            else "other_kms_event",
                            "cryptographicOperation": name in crypto,
                            "unclassifiedOperation": name not in crypto | management,
                            "reportedError": bool(
                                raw.get("errorCode") or raw.get("errorMessage")
                            ),
                            "matchesRetainedSourceCredential": (
                                principal["accessKeyId"]
                                == environment["AWS_ACCESS_KEY_ID"]
                                if "accessKeyId" in principal
                                else None
                            ),
                            "principalSha256": hashlib.sha256(
                                json.dumps(
                                    {
                                        key: principal.get(key)
                                        for key in ["type", "arn", "principalId"]
                                    },
                                    sort_keys=True,
                                ).encode()
                            ).hexdigest(),
                        }
                    )
                token = page.get("NextToken")
                if token is None:
                    query["complete"] = True
                    break
                require(
                    isinstance(token, str)
                    and 0 < len(token) <= 16384
                    and token not in tokens,
                    "invalid_audit_pagination",
                )
                tokens.add(token)
            require(query["complete"], "audit_page_limit_reached")
        report["events"].sort(
            key=lambda event: (event["eventTime"], event["eventName"])
        )
        report["totals"] = {
            "uniqueEvents": len(report["events"]),
            "cryptographicOperations": sum(
                event["cryptographicOperation"] for event in report["events"]
            ),
            "unclassifiedOperations": sum(
                event["unclassifiedOperation"] for event in report["events"]
            ),
            "reportedErrors": sum(event["reportedError"] for event in report["events"]),
        }
        report["collectionComplete"] = True
        report["result"] = "collected"
    except BaseException as error:
        report["result"] = "failed"
        report["failure"] = (
            str(error) if isinstance(error, MigrationError) else "unexpected_error"
        )
        if isinstance(error, AwsOperationError):
            report["awsFailure"] = error.details
        raise
    finally:
        report["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (output / "source-audit.json").write_text(json.dumps(report, indent=2) + "\n")


def verify_target_production():
    """Refresh current ciphertext evidence without source credentials or canaries."""
    output = Path(required_env("RUNNER_TEMP")) / "kms-production-reports"
    output.mkdir(mode=0o700)
    report = {
        "version": 1,
        "operation": "verify-target",
        "runId": required_env("GITHUB_RUN_ID"),
        "commit": required_env("GITHUB_SHA"),
        "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "source": SOURCE,
        "target": TARGET,
        "result": "running",
        "collectionComplete": False,
        "retirementCleared": False,
        "productionConfigurationChanged": False,
        "productionDataChanged": False,
        "sourceCredentialsRead": False,
        "sourceCanaryCreated": False,
        "verificationStarted": False,
        "kmsCallsMade": False,
    }
    try:
        expected = required_env("EXPECTED_DEPLOYMENT_ID")
        require(
            re.fullmatch(r"dpl_[A-Za-z0-9]+", expected),
            "invalid_expected_deployment",
        )
        require(not os.environ.get("CURSOR"), "final_verification_must_not_resume")
        require(
            required_env("SECRETS_KMS_KEY_ID") == TARGET
            and required_env("AWS_REGION") == "us-west-2",
            "target_runtime_configuration_required",
        )
        deployment = production_deployment(expected)
        report["deployment"] = deployment
        environment, session = target_session()
        report["targetSession"] = session
        # This path explicitly authorizes the uniquely resolved production DB.
        # Snapshot callers continue to require their own isolated preview.
        connection = database_url()
        require(
            production_deployment(expected) == deployment,
            "deployment_changed_before_verification",
        )
        report["verificationStarted"] = True
        report["kmsCallsMade"] = None
        verified = verify_database(
            urllib.parse.urlsplit(connection), environment, time.monotonic() + 4500
        )
        report["verification"] = verified
        report["kmsCallsMade"] = True
        require(
            database_url() == connection,
            "production_database_connection_changed",
        )
        require(
            production_deployment(expected) == deployment,
            "deployment_changed_during_verification",
        )
        require(
            datetime.datetime.fromisoformat(session["expiration"])
            > datetime.datetime.now(datetime.timezone.utc),
            "target_session_expired_during_verification",
        )
        report["collectionComplete"] = True
        report["result"] = "passed"
    except BaseException as error:
        report["result"] = "failed"
        report["failure"] = (
            str(error)
            if isinstance(error, (MigrationError, RecoveryVerificationError))
            else "unexpected_error"
        )
        if isinstance(error, RecoveryVerificationError) and error.diagnostics:
            report["verificationFailure"] = error.diagnostics
        raise
    finally:
        report["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (output / "target-verification.json").write_text(
            json.dumps(report, indent=2) + "\n"
        )


def main():
    mode = required_env("KMS_OPERATION")
    require(
        mode in {"verify", "verify-target", "verify-business", "migrate", "source-audit"},
        "invalid_operation",
    )
    workflow = {
        "verify": "kms-production-preflight.yml",
        "verify-target": "kms-production-preflight.yml",
        "verify-business": "kms-production-business-verify.yml",
        "migrate": "kms-production-migrate.yml",
        "source-audit": "kms-production-preflight.yml",
    }[mode]
    require(
        required_env("GITHUB_REPOSITORY") == "vm0-ai/vm0"
        and required_env("GITHUB_REF") == "refs/heads/main"
        and required_env("GITHUB_EVENT_NAME") == "workflow_dispatch",
        "protected_manual_main_required",
    )
    require(
        required_env("GITHUB_WORKFLOW_REF")
        == "vm0-ai/vm0/.github/workflows/" + workflow + "@refs/heads/main",
        "workflow_scope_mismatch",
    )
    require(
        required_env("GITHUB_RUN_ID").isdigit()
        and re.fullmatch(r"[0-9a-f]{40}", required_env("GITHUB_SHA")),
        "invalid_workflow_provenance",
    )
    if mode == "verify-target":
        verify_target_production()
        return
    require(
        re.fullmatch(r"[0-9a-f]{64}", required_env("EXPECTED_BACKUP_SHA256")),
        "invalid_backup_digest",
    )
    if mode == "source-audit":
        source_audit()
        return
    expected = required_env("EXPECTED_DEPLOYMENT_ID")
    require(re.fullmatch(r"dpl_[A-Za-z0-9]+", expected), "invalid_expected_deployment")
    cursor = os.environ.get("CURSOR", "")
    require(len(cursor) <= 16384, "invalid_cursor_length")
    require(mode == "migrate" or not cursor, "final_verification_must_not_resume")
    limit = os.environ.get("MAX_ROWS", "1000")
    require(
        re.fullmatch(r"[0-9]{1,6}", limit) and 1 <= int(limit) <= 100000,
        "invalid_migration_limit",
    )
    if mode in {"migrate", "verify-business"}:
        require(
            required_env("KMS_MIGRATION_ROLE_ARN") == OPERATOR,
            "migration_role_not_configured",
        )
    configuration = {name: required_env(name) for name in CONFIG_NAMES}
    require(
        configuration["SECRETS_KMS_KEY_ID"] == TARGET
        and not os.environ.get("AWS_SESSION_TOKEN"),
        "target_runtime_configuration_required",
    )
    target_environment = runtime_environment(configuration)
    source_environment = runtime_environment(backup_configuration())
    deployment = production_deployment(expected)
    temporary = Path(required_env("RUNNER_TEMP"))
    output = temporary / "kms-production-reports"
    output.mkdir(mode=0o700)
    fixture = temporary / "kms-production-canary"
    fixture.mkdir(mode=0o700)
    metadata = {
        "version": 1,
        "operation": mode,
        "runId": required_env("GITHUB_RUN_ID"),
        "commit": required_env("GITHUB_SHA"),
        "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "deployment": deployment,
        "backupSnapshotSha256": required_env("EXPECTED_BACKUP_SHA256"),
        "result": "running",
        "productionConfigurationChanged": False,
        "staticCredentialsCreated": False,
    }
    try:
        metadata["sourceRuntimePrincipal"] = canary(
            "prepare-old", source_environment, fixture
        )
        metadata["targetRuntimePrincipal"] = canary(
            "verify-new", target_environment, fixture
        )
        canary("verify-rollback", source_environment, fixture)
        metadata["runtimeCanaryAndRollback"] = "passed"
        target_environment["DATABASE_URL"] = database_url()
        if mode == "verify-business":
            operator = assume_operator(target_environment)
            metadata["migrationOperator"] = canary("verify-operator", operator, fixture)
            metadata["operatorReencryptAndRollback"] = "passed"
            require(
                production_deployment(expected) == deployment,
                "deployment_changed_before_business_verification",
            )
            # The API verifier needs no AWS credentials or provider control-plane
            # tokens. Only its dedicated Clerk login and scoped DB fixtures write.
            business_environment = {
                name: value
                for name, value in target_environment.items()
                if not name.startswith("AWS_") and name != "SECRETS_KMS_KEY_ID"
            }
            for name in [
                "CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY",
            ]:
                business_environment[name] = required_env(name)
            report_path = output / "business-verification.json"
            run_tool(
                [MIGRATION + "/verify-business.ts", str(fixture), str(report_path),
                 required_env("BUSINESS_USER_ID"), required_env("BUSINESS_ORG_ID"),
                 required_env("BUSINESS_AGENT_ID")],
                business_environment,
            )
            business = json.loads(report_path.read_text())
            require(
                business["result"] == "passed"
                and business["cleanup"] == "passed"
                and business["cleanupFailures"] == []
                and business["historicalCiphertextWrites"] == 0
                and business["fixtureWrites"] == 4
                and business["checks"] == [
                    "deployed_webhook_create_and_reveal_target_key",
                    "deployed_connector_add_and_shared_reader",
                    "deployed_connector_reconnect_and_shared_reader",
                    "deployed_source_envelope_read",
                    "deployed_source_legacy_read",
                ],
                "business_verification_or_cleanup_incomplete",
            )
            require(
                production_deployment(expected) == deployment,
                "deployment_changed_during_business_verification",
            )
            metadata["businessVerification"] = "passed"
            metadata["historicalCiphertextWrites"] = 0
            metadata["result"] = "passed"
            return
        verification_path = output / "verification.json"
        common = ["--source-key", SOURCE, "--target-key", TARGET, "--batch-size", "100"]
        run_tool(
            [
                MIGRATION + "/backfill.ts",
                *common,
                "--verify",
                "--verify-concurrency",
                "8",
                "--max-rows",
                "1000000",
                "--report-path",
                str(verification_path),
            ],
            target_environment,
        )
        verified = read_verification(verification_path)
        metadata["targetRuntimeVerification"] = {
            "databaseVerifiedOnTarget": verified["databaseVerifiedOnTarget"],
            "totals": verified["totals"],
            "database": verified["database"],
            "manifest": verified["manifest"],
        }
        require(
            production_deployment(expected) == deployment,
            "deployment_changed_during_verification",
        )
        if mode == "migrate":
            operator = assume_operator(target_environment)
            metadata["migrationOperator"] = canary("verify-operator", operator, fixture)
            metadata["operatorReencryptAndRollback"] = "passed"
            require(
                production_deployment(expected) == deployment,
                "deployment_changed_before_migration",
            )
            args = [
                MIGRATION + "/backfill.ts",
                *common,
                "--migrate",
                "--preflight",
                str(verification_path),
                "--max-rows",
                limit,
                "--report-path",
                str(output / "migration.json"),
            ]
            if cursor:
                args.extend(["--cursor", cursor])
            run_tool(args, operator)
            migrated = json.loads((output / "migration.json").read_text())
            require(
                migrated["mode"] == "migrate"
                and migrated["failure"] is None
                and migrated["source"] == SOURCE
                and migrated["target"] == TARGET,
                "migration_report_failed",
            )
            metadata["migration"] = {
                "complete": migrated["complete"],
                "cursor": migrated["cursor"],
                "totals": migrated["totals"],
            }
            metadata["freshFinalTargetVerificationRequired"] = True
        require(
            production_deployment(expected) == deployment,
            "deployment_changed_during_operation",
        )
        metadata["result"] = "passed"
    except BaseException as error:
        metadata["result"] = "failed"
        metadata["failure"] = (
            str(error) if isinstance(error, MigrationError) else "unexpected_error"
        )
        if isinstance(error, AwsOperationError):
            metadata["awsFailure"] = error.details
        raise
    finally:
        metadata["finishedAt"] = datetime.datetime.now(
            datetime.timezone.utc
        ).isoformat()
        (output / "operation.json").write_text(json.dumps(metadata, indent=2) + "\n")
        shutil.rmtree(fixture)
    print(json.dumps(metadata))


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        print(
            "KMS production operation failed: "
            + (str(error) if isinstance(error, MigrationError) else "unexpected_error"),
            file=sys.stderr,
        )
        sys.exit(1)
