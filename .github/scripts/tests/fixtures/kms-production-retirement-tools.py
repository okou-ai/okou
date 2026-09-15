#!/usr/bin/env python3
"""Synthetic GitHub, Doppler, Vercel and AWS boundaries for the real CLI."""

import base64
import datetime
import json
import os
from pathlib import Path
import sys


binary = Path(sys.argv[0])
state_path = binary.parent.parent / "provider.json"
state = json.loads(state_path.read_text())
args = sys.argv[1:]
scenario = state["scenario"]
source = state["snapshot"]["sourceKeyArn"]


def save():
    state_path.write_text(json.dumps(state))


def reject(code):
    save()
    print("synthetic-provider-secret-must-not-leak")
    print(
        f"An error occurred ({code}) when calling the operation: synthetic-provider-secret-must-not-leak",
        file=sys.stderr,
    )
    sys.exit(255)


if binary.name == "gh":
    assert args == [
        "api",
        "repos/vm0-ai/vm0/actions/artifacts/123/zip",
        "--allow-escape-sequences",
    ]
    raw = base64.b64decode(state["archive"])
    sys.stdout.buffer.write(
        raw + (b"changed" if scenario == "archive-changed" else b"")
    )
    sys.exit(0)

if binary.name == "curl":
    url = next(arg for arg in args if arg.startswith("https://"))
    if url == "https://api.github.com/repos/vm0-ai/vm0/actions/runs/54321":
        result = state["run"]
    elif (
        url
        == "https://api.github.com/repos/vm0-ai/vm0/actions/runs/54321/artifacts?per_page=100"
    ):
        result = {"total_count": 1, "artifacts": [state["artifact"]]}
    elif (
        url
        == "https://api.vercel.com/v9/projects/prj_6mw0CgYjECVrJV57VJ47VN03B4UR?teamId=team_WRqI0kCoX5KcRInRWgZ1nBF0"
    ):
        state["deploymentReads"] += 1
        deployment = {
            **state["deployment"],
            "readyState": "READY",
            "target": "production",
            "alias": ["api.okou.ai"],
            "meta": {"githubCommitSha": state["deployment"]["commit"]},
        }
        if scenario == "deployment-changed" and state["deploymentReads"] == 2:
            deployment["id"] = "dpl_changed"
        result = {
            "id": "prj_6mw0CgYjECVrJV57VJ47VN03B4UR",
            "accountId": "team_WRqI0kCoX5KcRInRWgZ1nBF0",
            "targets": {"production": deployment},
        }
    elif ".actions.githubusercontent.com/" in url:
        result = {"value": "synthetic-oidc-secret"}
    elif url == "https://api.doppler.com/v3/auth/oidc":
        assert json.loads(sys.stdin.read())["token"] == "synthetic-oidc-secret"
        result = {"token": "synthetic-doppler-secret"}
    else:
        assert (
            url
            == "https://api.doppler.com/v3/configs/config/secrets?project=vm0-kms-rollback-32264&config=prd&include_managed_secrets=false"
        )
        assert args[args.index("--request") + 1] == "GET"
        raw = json.dumps(state["snapshot"], separators=(",", ":"))
        if scenario == "backup-changed":
            raw += " "
        result = {
            "secrets": {
                "KMS_BACKUP_JSON": {
                    "raw": raw,
                    "computed": raw,
                    "rawVisibility": "masked",
                    "computedVisibility": "masked",
                }
            }
        }
    save()
    print(json.dumps(result) + "\n200", end="")
    sys.exit(0)

assert binary.name == "aws"
assert os.environ["AWS_ACCESS_KEY_ID"] == "synthetic-source-access-key"
assert os.environ["AWS_SECRET_ACCESS_KEY"] == "synthetic-source-secret"
for name in [
    "GH_TOKEN",
    "VERCEL_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "AWS_ENDPOINT_URL",
]:
    assert name not in os.environ
assert args[-4:] == ["--region", "us-west-2", "--output", "json"]
if args[:2] == ["sts", "get-caller-identity"]:
    result = {
        "Account": "072707626411",
        "Arn": "arn:aws:iam::072707626411:user/vm0-kms-prod",
    }
    if scenario == "wrong-principal":
        result["Arn"] = "arn:aws:iam::072707626411:user/other"
elif args[:3] == ["cloudtrail", "lookup-events", "--no-paginate"]:
    payload = json.loads(
        Path(
            args[args.index("--cli-input-json") + 1].removeprefix("file://")
        ).read_text()
    )
    assert payload["LookupAttributes"][0]["AttributeValue"] in {
        source,
        source.rsplit("/", 1)[1],
    }
    result = {"Events": []}
    if scenario == "audit-denied":
        reject("AccessDeniedException")
    if scenario == "source-crypto":
        event_id = "11111111-2222-3333-4444-555555555555"
        raw = {
            "eventID": event_id,
            "eventSource": "kms.amazonaws.com",
            "awsRegion": "us-west-2",
            "recipientAccountId": "072707626411",
            "eventTime": state["eventTime"],
            "eventName": "Decrypt",
            "userIdentity": {"type": "IAMUser", "arn": "synthetic-private-principal"},
        }
        result["Events"] = [
            {
                "EventId": event_id,
                "EventName": "Decrypt",
                "Resources": [{"ResourceName": source}],
                "CloudTrailEvent": json.dumps(raw),
            }
        ]
elif args[:2] == ["kms", "describe-key"]:
    assert args[2:4] == ["--key-id", source]
    assert os.environ["AWS_MAX_ATTEMPTS"] == "1"
    if scenario == "not-found":
        reject("NotFoundException")
    if scenario == "describe-denied":
        reject("AccessDeniedException")
    result = {"KeyMetadata": state["key"]}
    if scenario == "wrong-key":
        result["KeyMetadata"] = {**state["key"], "Arn": state["targetKey"]["Arn"]}
elif args[:2] == ["kms", "schedule-key-deletion"]:
    assert args[2:6] == ["--key-id", source, "--pending-window-in-days", "7"]
    assert os.environ["AWS_MAX_ATTEMPTS"] == "1"
    state["scheduleRequests"] += 1
    if scenario == "schedule-denied":
        reject("AccessDeniedException")
    assert state["key"]["KeyState"] in {"Enabled", "Disabled"}
    date = (
        datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=7)
    ).isoformat()
    state["key"].update(KeyState="PendingDeletion", Enabled=False, DeletionDate=date)
    if scenario == "lost-response":
        reject("DependencyTimeoutException")
    result = {
        "KeyId": source,
        "PendingWindowInDays": 7,
        "DeletionDate": date,
    }
else:
    raise AssertionError("Unexpected external operation")
save()
print(json.dumps(result))
