#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
python3 - "$repo_root" <<'PY'
import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import sys
import urllib.error
from unittest.mock import patch

import yaml

root = Path(sys.argv[1])
script = root / ".github/scripts/diagnose-discord-gateway.py"
workflow = yaml.load((root / ".github/workflows/discord-gateway-diagnose.yml").read_text(), Loader=yaml.BaseLoader)
assert set(workflow["on"]) == {"workflow_dispatch"}
job = workflow["jobs"]["diagnose"]
assert "github.ref == 'refs/heads/main'" in job["if"]
assert job["environment"] == "${{ inputs.environment }}"
assert workflow["permissions"] == {"contents": "read"}
assert job["steps"][-1]["run"] == "python3 .github/scripts/diagnose-discord-gateway.py"
assert set(job["steps"][-1]["env"]) == {"DISCORD_APPLICATION_ID", "DISCORD_BOT_TOKEN"}

secret = "private-bot-credential"
application_id = "123456789012345678"
metadata = {"url": "wss://gateway.discord.gg", "shards": 1, "session_start_limit": {
    "total": 1000, "remaining": 1000, "reset_after": 0, "max_concurrency": 1}}

class Response(io.BytesIO):
    status = 200

class Discord:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def open(self, request, timeout):
        assert request.get_method() == "GET"
        assert request.get_header("Authorization") == "Bot " + secret
        assert timeout == 10
        expected = ["/applications/@me", "/gateway/bot"][len(self.calls)]
        assert request.full_url == "https://discord.com/api/v10" + expected
        self.calls.append(expected)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return Response(reply if isinstance(reply, bytes) else json.dumps(reply).encode())

def run(replies, changes=None):
    provider = Discord(replies)
    output = io.StringIO()
    def opener(handler):
        assert handler.redirect_request(None, None, 302, secret, {}, "https://other.invalid") is None
        return provider
    with patch.dict(os.environ, {"DISCORD_BOT_TOKEN": secret, "DISCORD_APPLICATION_ID": application_id} | (changes or {})), patch("urllib.request.build_opener", side_effect=opener), contextlib.redirect_stdout(output):
        try:
            runpy.run_path(str(script), run_name="__main__")
        except SystemExit as result:
            status = result.code
    assert secret not in output.getvalue(), "credentials and provider strings must not leave the probe"
    return status, [json.loads(line) for line in output.getvalue().splitlines()], provider.calls

status, reports, calls = run([{"id": application_id}, metadata])
assert status == 0 and len(calls) == 2
assert reports[-1]["fields"]["session_start_limit.reset_after"] == {"type": "number", "value": 0, "integer": True}

tainted = {"url": "wss://user:" + secret + "@other.invalid/path?token=" + secret,
           "shards": secret, "session_start_limit": {"reset_after": secret}, secret: secret}
status, reports, _ = run([{"id": application_id}, tainted])
assert status == 0
assert reports[-1]["fields"]["shards"] == {"type": "string"}
assert reports[-1]["fields"]["session_start_limit.total"] == {"type": "missing"}

status, _, calls = run([{"id": "different-application"}])
assert status == 1 and len(calls) == 1
for failure in [urllib.error.HTTPError("https://discord.com", 429, secret, {}, io.BytesIO(secret.encode())),
                urllib.error.URLError(secret), secret.encode(), b"x" * 65537, []]:
    status, reports, calls = run([failure])
    assert status == 1 and len(calls) == 1
    assert "error" in reports[-1]
status, _, calls = run([], {"DISCORD_BOT_TOKEN": ""})
assert status == 1 and not calls
print("Discord read-only probe: metadata, identity, redaction, redirects, bounded failures: ok")
PY
