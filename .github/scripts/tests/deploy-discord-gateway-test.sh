#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
bash -n "$repo_root/.github/scripts/deploy-discord-gateway.sh"

python3 - "$repo_root" <<'PY'
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import yaml

root = Path(sys.argv[1])
script = root / ".github/scripts/deploy-discord-gateway.sh"
workflow = yaml.load(
    (root / ".github/workflows/discord-gateway-deploy.yml").read_text(),
    Loader=yaml.BaseLoader,
)
assert set(workflow["on"]) == {"workflow_dispatch"}, "deployment must remain manual"
job = workflow["jobs"]["deploy"]
assert "github.ref == 'refs/heads/main'" in job["if"], "only main may deploy"
assert job["environment"] == "${{ inputs.environment }}", "respect environment protections"
assert workflow["defaults"]["run"]["shell"] == "bash", "container scripts need Bash"
assert workflow["on"]["workflow_dispatch"]["inputs"]["environment"]["options"] == [
    "test", "production"
], "restrict deployment targets"

keys = [
    "DISCORD_APPLICATION_ID", "DISCORD_BOT_TOKEN", "DISCORD_GATEWAY_SECRET",
    "DISCORD_GATEWAY_CONTROL_SECRET", "DISCORD_API_ORIGIN",
]
with tempfile.TemporaryDirectory() as temporary:
    work = Path(temporary)
    binary = work / "pnpm"
    binary.write_text("""#!/usr/bin/env python3
import json, os, pathlib, stat, sys
args = sys.argv[1:]
secret_file = pathlib.Path(args[args.index('--secrets-file') + 1])
result = {
    'args': args,
    'secret_file': str(secret_file),
    'secrets': json.loads(secret_file.read_text()),
    'mode': stat.S_IMODE(secret_file.stat().st_mode),
    'inherited_discord_keys': sorted(k for k in os.environ if k.startswith('DISCORD_')),
}
pathlib.Path(os.environ['GATEWAY_TEST_CAPTURE']).write_text(json.dumps(result))
sys.exit(int(os.environ.get('GATEWAY_TEST_EXIT', '0')))
""")
    binary.chmod(0o755)
    capture = work / "call.json"
    env = {
        "PATH": str(work) + os.pathsep + os.environ["PATH"],
        "GATEWAY_TEST_CAPTURE": str(capture),
        "CLOUDFLARE_API_TOKEN": "test-cloudflare-token",
        "CLOUDFLARE_ACCOUNT_ID": "test-account",
        "DISCORD_APPLICATION_ID": "123456789012345678",
        "DISCORD_BOT_TOKEN": "test-discord-bot-token",
        "DISCORD_GATEWAY_SECRET": "signing-secret-" + "a" * 32,
        "DISCORD_GATEWAY_CONTROL_SECRET": "control-secret-" + "b" * 32,
        "DISCORD_API_ORIGIN": "https://api.example.test",
    }

    def run(target, changes=None):
        capture.unlink(missing_ok=True)
        selected = env | (changes or {})
        result = subprocess.run(
            ["bash", str(script), target], env=selected, capture_output=True, text=True,
        )
        for key in keys:
            assert env[key] not in result.stdout + result.stderr, "credentials must not be logged"
        return result

    for target in ("test", "production"):
        result = run(target)
        assert result.returncode == 0, "valid configuration must reach deploy"
        call = json.loads(capture.read_text())
        args = call["args"]
        assert args[:5] == ["--filter", "@okouai/discord-gateway-worker", "exec", "wrangler", "deploy"]
        assert args[args.index("--env") + 1] == target, "preserve exact environment"
        assert args[args.index("--var") + 1] == "DISCORD_GATEWAY_ENABLED:false", "deployment cannot activate"
        assert call["secrets"] == {key: env[key] for key in keys}, "pass all encrypted bindings"
        assert call["inherited_discord_keys"] == [], "credentials must leave the child environment"
        assert call["mode"] == 0o600, "temporary credential file must be private"
        assert not Path(call["secret_file"]).exists(), "delete credential file after success"
        for key in keys:
            assert env[key] not in " ".join(args), "credentials must not enter command arguments"

    for target, changes in (
        ("preview", {}),
        ("test", {"DISCORD_GATEWAY_CONTROL_SECRET": ""}),
        ("test", {"DISCORD_GATEWAY_SECRET": "too-short"}),
        ("test", {"DISCORD_GATEWAY_CONTROL_SECRET": env["DISCORD_GATEWAY_SECRET"]}),
        ("test", {"DISCORD_APPLICATION_ID": "not-a-snowflake"}),
        ("test", {"DISCORD_API_ORIGIN": "http://api.example.test"}),
        ("test", {"DISCORD_API_ORIGIN": "https://api.example.test/path"}),
        ("test", {"DISCORD_API_ORIGIN": "https://user:password@api.example.test"}),
    ):
        result = run(target, changes)
        assert result.returncode != 0, "invalid configuration must fail closed"
        assert not capture.exists(), "reject invalid configuration before deployment"

    result = run("test", {"GATEWAY_TEST_EXIT": "17"})
    assert result.returncode == 17, "preserve deployment failures"
    call = json.loads(capture.read_text())
    assert not Path(call["secret_file"]).exists(), "delete credential file after failure"

print("Discord Gateway deployment boundary: passed")
PY
