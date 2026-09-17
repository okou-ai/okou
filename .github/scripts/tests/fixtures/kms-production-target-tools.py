#!/usr/bin/env python3
"""Provider and child-process boundaries for the protected target verifier."""

import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.parse

binary = Path(sys.argv[0])
state_path = binary.parent.parent / "provider.json"
state = json.loads(state_path.read_text())
scenario = state["scenario"]
arguments = sys.argv[1:]
target = "arn:aws:kms:us-west-2:251964670836:key/e68917e2-5541-4597-b6ef-7e9eb5670947"
source = "arn:aws:kms:us-west-2:072707626411:key/a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8"


def record(call):
    state["calls"].append(call)
    state_path.write_text(json.dumps(state))


if binary.name == "curl":
    url = next(value for value in arguments if value.startswith("https://"))
    assert "--data-binary" not in arguments
    assert (
        "--request" not in arguments
        or arguments[arguments.index("--request") + 1] == "GET"
    )
    if ".actions.githubusercontent.com/" in url:
        record("oidc")
        result = {"value": "fixture-private-oidc"}
    elif "api.vercel.com/v9/projects/" in url:
        record("deployment")
        changed = (
            scenario == "deployment-changed" and state["calls"].count("deployment") == 3
        )
        result = {
            "id": "prj_6mw0CgYjECVrJV57VJ47VN03B4UR",
            "accountId": "team_WRqI0kCoX5KcRInRWgZ1nBF0",
            "targets": {
                "production": {
                    "id": "dpl_changed" if changed else "dpl_fixture",
                    "readyState": "READY",
                    "target": "production",
                    "alias": ["api.okou.ai"],
                    "url": "fixture.vm6.ai",
                    "meta": {"githubCommitSha": "b" * 40},
                }
            },
        }
    elif "console.neon.tech/api/v2/projects/hidden-lab-39609750/branches" in url:
        record("branches")
        result = {"branches": [{"id": "br-production", "name": "production"}]}
    elif "console.neon.tech/api/v2/projects/hidden-lab-39609750/connection_uri?" in url:
        record("connection")
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        assert query == {
            "branch_id": ["br-production"],
            "database_name": ["neondb"],
            "role_name": ["neondb_owner"],
            "pooled": ["false"],
        }
        changed = (
            scenario == "connection-changed" and state["calls"].count("connection") == 2
        )
        host = "changed.neon.tech" if changed else "fixture.neon.tech"
        result = {
            "uri": f"postgresql://neondb_owner:fixture-private-password@{host}/neondb"
        }
    else:
        raise AssertionError("unexpected provider request")
    print(json.dumps(result) + "\n200", end="")
    raise SystemExit(0)

assert binary.name in {"aws", "pnpm"}
for name in [
    "VERCEL_TOKEN",
    "NEON_API_KEY",
    "DOPPLER_SERVICE_IDENTITY_ID",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
]:
    assert name not in os.environ
assert os.environ["AWS_CONFIG_FILE"] == "/dev/null"
assert os.environ["AWS_SHARED_CREDENTIALS_FILE"] == "/dev/null"
if binary.name == "aws":
    assert arguments[0] == "sts"
    if arguments[1] == "assume-role-with-web-identity":
        record("assume")
        path = Path(
            arguments[arguments.index("--cli-input-json") + 1].removeprefix("file://")
        )
        body = json.loads(path.read_text())
        assert json.loads(path.read_text()) == body
        assert body["WebIdentityToken"] == "fixture-private-oidc"
        assert (
            body["RoleArn"]
            == "arn:aws:iam::251964670836:role/vm0-kms-migration-github-32264"
        )
        assert body["RoleSessionName"] == "kms-recovery-12345"
        assert json.loads(body["Policy"])["Statement"] == [
            {
                "Effect": "Allow",
                "Action": "kms:Decrypt",
                "Resource": target,
                "Condition": {
                    "StringEquals": {
                        "kms:EncryptionContext:purpose": "vm0-stored-secret"
                    }
                },
            },
            {"Effect": "Deny", "Action": "kms:*", "NotResource": target},
            {
                "Effect": "Deny",
                "NotAction": ["kms:Decrypt", "sts:GetCallerIdentity"],
                "Resource": "*",
            },
        ]
        if scenario == "session-denied":
            print(
                "An error occurred (AccessDenied) fixture-private-provider-error",
                file=sys.stderr,
            )
            raise SystemExit(254)
        print(
            json.dumps(
                {
                    "Credentials": {
                        "AccessKeyId": "fixture-temporary-access",
                        "SecretAccessKey": "fixture-private-session-secret",
                        "SessionToken": "fixture-private-session-token",
                        "Expiration": (
                            dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=2)
                        ).isoformat(),
                    }
                }
            )
        )
    else:
        assert arguments[1] == "get-caller-identity"
        record("identity")
        account = "072707626411" if scenario == "wrong-session" else "251964670836"
        print(
            json.dumps(
                {
                    "Account": account,
                    "Arn": f"arn:aws:sts::{account}:assumed-role/vm0-kms-migration-github-32264/kms-recovery-12345",
                }
            )
        )
    raise SystemExit(0)

# The unchanged backfill CLI has its own real PostgreSQL + HTTP KMS integration
# suite. Exercise this controller's subprocess/report contract here, including
# failure reports a successful real decrypt cannot produce.
record("verify")
assert arguments[:3] == [
    "exec",
    "tsx",
    "scripts/migrations/013-kms-account-rotation/backfill.ts",
]
assert "--verify" in arguments and "--recovery-schema" in arguments
assert not set(arguments) & {"--migrate", "--cursor", "--preflight"}
assert os.environ["AWS_ACCESS_KEY_ID"] == "fixture-temporary-access"
uri = urllib.parse.urlsplit(os.environ["DATABASE_URL"])
assert uri.hostname == "fixture.neon.tech" and uri.path == "/neondb"
assert urllib.parse.parse_qs(uri.query) == {"sslmode": ["verify-full"]}
database = hashlib.sha256(
    f"{uri.netloc.split('@')[-1]}{uri.path}:{uri.username}".encode()
).hexdigest()
totals = dict.fromkeys(
    [
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
    ],
    0,
)
totals.update(rows=3, envelope=3, target=3, verified=3)
report = {
    "mode": "verify",
    "recoverySchema": True,
    "source": source,
    "target": target,
    "database": database,
    "manifest": "c" * 64,
    "complete": True,
    "resumed": False,
    "databaseVerifiedOnTarget": True,
    "failure": None,
    "cursor": None,
    "totals": totals,
}
if scenario == "source-ciphertext":
    report["totals"].update(source=1, verified=2, target=2)
    report["databaseVerifiedOnTarget"] = False
elif scenario == "wrong-database":
    report["database"] = "d" * 64
elif scenario == "historical-manifest":
    report["recoverySchema"] = False
elif scenario == "tool-failed":
    report.update(
        complete=False,
        failure="migration_failed_at_cursor",
        cursor={"private": "fixture-private-cursor"},
    )
    report["failureDetails"] = {
        "stage": "process_rows",
        "code": "AccessDeniedException",
        "private": "fixture-private-password",
    }
Path(arguments[arguments.index("--report-path") + 1]).write_text(json.dumps(report))
if scenario == "tool-failed":
    print("fixture-private-password", file=sys.stderr)
    raise SystemExit(1)
