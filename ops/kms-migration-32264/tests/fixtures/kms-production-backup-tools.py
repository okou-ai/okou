#!/usr/bin/env python3
"""Isolated AWS/curl command boundary for the production backup CLI tests."""

import json
import os
import sys
import urllib.parse
from pathlib import Path

state_path = Path(os.environ["BACKUP_FIXTURE_STATE"])
state = json.loads(state_path.read_text())
scenario = state["scenario"]
arguments = sys.argv[1:]
source_key = (
    "arn:aws:kms:us-west-2:072707626411:key/a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8"
)
status = 200

if Path(sys.argv[0]).name == "aws":
    assert arguments[arguments.index("--region") + 1] == "us-west-2"
    if arguments[:2] == ["sts", "get-caller-identity"]:
        response = {
            "Account": "072707626411",
            "Arn": "arn:aws:iam::072707626411:user/vm0-kms-prod",
        }
        if scenario == "wrong-principal":
            response["Arn"] = "arn:aws:iam::072707626411:user/unexpected"
    else:
        assert arguments[:2] == ["kms", "generate-data-key"]
        assert arguments[arguments.index("--query") + 1] == "KeyId"
        response = source_key
    print(json.dumps(response))
    sys.exit(0)

assert Path(sys.argv[0]).name == "curl"
method = arguments[arguments.index("--request") + 1]
url = next(value for value in arguments if value.startswith("https://"))
parsed = urllib.parse.urlsplit(url)
body = json.load(sys.stdin) if method == "POST" else None
headers = [
    arguments[index + 1] for index, value in enumerate(arguments) if value == "--header"
]
state["requests"].append(
    {"method": method, "host": parsed.hostname, "path": parsed.path}
)

if parsed.hostname == "pipelines.actions.githubusercontent.com":
    owner = os.environ["GITHUB_REPOSITORY"].partition("/")[0]
    assert urllib.parse.parse_qs(parsed.query)["audience"] == [
        "https://github.com/" + owner
    ]
    assert "Authorization: Bearer github-request-fixture" in headers
    response = {"value": "oidc-fixture-secret"}
elif parsed.hostname == "api.vercel.com":
    assert "Authorization: Bearer vercel-fixture-secret" in headers
    state["deploymentReads"] += 1
    deployment_id = "dpl_fixture"
    if scenario == "changed-deployment" and state["deploymentReads"] == 2:
        deployment_id = "dpl_changed"
    response = {
        "id": "prj_6mw0CgYjECVrJV57VJ47VN03B4UR",
        "accountId": "team_WRqI0kCoX5KcRInRWgZ1nBF0",
        "targets": {
            "production": {
                "id": deployment_id,
                "url": "fixture.vm6.ai",
                "readyState": "READY",
                "target": "production",
                "alias": ["api.okou.ai"],
                "meta": {"githubCommitSha": "b" * 40},
            }
        },
    }
elif parsed.hostname == "api.doppler.com" and parsed.path == "/v3/auth/oidc":
    assert body == {
        "identity": "c0c87790-e651-45dd-b7fa-c5ed07bb990f",
        "token": "oidc-fixture-secret",
    }
    response = {"token": "doppler-fixture-secret", "expires_at": "2026-09-09T08:00:00Z"}
    if scenario == "provider-error":
        status = 403
        response = {
            "message": "oidc-fixture-secret doppler-fixture-secret "
            + os.environ["AWS_SECRET_ACCESS_KEY"]
        }
elif (
    parsed.hostname == "api.doppler.com" and parsed.path == "/v3/configs/config/secrets"
):
    assert "Authorization: Bearer doppler-fixture-secret" in headers
    if method == "GET":
        query = urllib.parse.parse_qs(parsed.query)
        assert query == {
            "project": ["vm0-kms-rollback-32264"],
            "config": ["prd"],
            "include_managed_secrets": ["false"],
        }
        response = {"secrets": state["secrets"]}
        if scenario == "readback-mismatch" and state["writes"]:
            response = json.loads(json.dumps(response))
            response["secrets"]["KMS_BACKUP_JSON"]["computed"] = "changed"
    else:
        assert body["project"] == "vm0-kms-rollback-32264" and body["config"] == "prd"
        assert len(body["change_requests"]) == 1
        change = body["change_requests"][0]
        assert change["name"] == "KMS_BACKUP_JSON"
        assert change["originalName"] is None and change["originalValue"] is None
        assert change["visibility"] == "masked"
        if scenario == "concurrent-backup":
            state["secrets"]["KMS_BACKUP_JSON"] = {
                "raw": "concurrent-original",
                "computed": "concurrent-original",
            }
        if "KMS_BACKUP_JSON" in state["secrets"]:
            status = 400
            response = {"success": False, "messages": ["Secret already exists"]}
        else:
            state["secrets"]["KMS_BACKUP_JSON"] = {
                "raw": change["value"],
                "computed": change["value"],
                "rawVisibility": "masked",
                "computedVisibility": "masked",
            }
            state["writes"] += 1
            response = {"success": True, "secrets": state["secrets"]}
else:
    raise RuntimeError("Unexpected external operation")

state_path.write_text(json.dumps(state))
print(json.dumps(response))
print(status, end="")
