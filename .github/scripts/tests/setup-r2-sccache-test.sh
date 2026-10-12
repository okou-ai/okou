#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_ROOT"' EXIT
yq -o=json '.' "${REPO_ROOT}/.github/actions/setup-r2-sccache/action.yml" > "${TEST_ROOT}/action.json"

# Execute the actual composite shell steps; mock only the external native process.
# No storage connection or real credential is used.
python3 - "$TEST_ROOT" <<'PY'
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

root = Path(sys.argv[1])
action = json.loads((root / "action.json").read_text())
inputs = {
    "architecture": "arm64",
    "r2-access-key-id": "fixture-access",
    "r2-secret-access-key": "fixture-secret",
    "r2-account-id": "fixture-account",
    "r2-bucket-name": "fixture-bucket",
}
assert action["runs"]["using"] == "composite"
assert set(action["inputs"]) == set(inputs)
assert all(v["required"] for v in action["inputs"].values())
steps = action["runs"]["steps"]
assert [s["name"] for s in steps] == ["Verify preinstalled sccache", "Configure R2 sccache"]
assert all(s["shell"] == "bash" and not s.get("continue-on-error", False) for s in steps)
assert steps[1]["id"] == "configure"
assert action["outputs"]["started"]["value"] == "${{ steps.configure.outputs.started }}"
bash = shutil.which("bash")
assert bash
fixture = root / "bin"
fixture.mkdir()
program = fixture / "sccache"
program.write_text('''#!/usr/bin/env bash
set -euo pipefail
[ "$#" = 1 ] && [ "$1" = --start-server ]
[ "$AWS_ACCESS_KEY_ID" = fixture-access ]
[ "$AWS_SECRET_ACCESS_KEY" = fixture-secret ]
[ "$SCCACHE_BUCKET" = fixture-bucket ]
[ "$SCCACHE_ENDPOINT" = https://fixture-account.r2.cloudflarestorage.com ]
[ "$SCCACHE_REGION" = auto ]
[ "$SCCACHE_S3_KEY_PREFIX" = "$EXPECTED_PREFIX" ]
[ "$SCCACHE_GHA_ENABLED" = false ]
[ "$SCCACHE_IDLE_TIMEOUT" = 0 ]
grep -qx 'server_startup_timeout_ms = 60000' "$SCCACHE_CONF"
[ "$FIXTURE_MODE" != failed-start ] || exit 23
touch "$SERVER_STARTED"
''')
program.chmod(0o755)


def run_case(label, architecture="arm64", overrides=None, mode="valid", export_failure=False):
    directory = root / label
    directory.mkdir()
    env_file = directory / "github-env"
    output = directory / "github-output"
    output.write_text("")
    if export_failure:
        env_file.mkdir()
    else:
        env_file.write_text("")
    values = {**inputs, "architecture": architecture, **(overrides or {})}
    env = {
        "PATH": str(fixture) + os.pathsep + os.environ["PATH"],
        "RUNNER_TEMP": str(directory),
        "GITHUB_ENV": str(env_file),
        "GITHUB_OUTPUT": str(output),
        "FIXTURE_MODE": mode,
        "SERVER_STARTED": str(directory / "started"),
        "EXPECTED_PREFIX": f"runner-sccache/{architecture}/",
    }
    if mode == "missing-binary":
        empty = directory / "empty-bin"
        empty.mkdir()
        env["PATH"] = str(empty)
    transcript = ""
    for step in steps:
        rendered = {}
        for key, value in step.get("env", {}).items():
            match = re.fullmatch(r"\$\{\{ inputs\.([a-z0-9-]+) \}\}", value)
            rendered[key] = values[match[1]] if match else value
        result = subprocess.run([bash, "-e", "-o", "pipefail", "-c", step["run"]],
                                env={**env, **rendered}, text=True, capture_output=True)
        transcript += result.stdout + result.stderr
        if result.returncode:
            break
    assert "fixture-access" not in transcript and "fixture-secret" not in transcript, label
    return result, directory, env_file, output


for architecture in ["arm64", "x86_64"]:
    result, directory, env_file, output = run_case(architecture, architecture)
    assert result.returncode == 0, result.stderr
    assert (directory / "started").exists()
    assert output.read_text() == "started=true\n"
    assert env_file.read_text().splitlines() == [
        "CARGO_INCREMENTAL=0", f"SCCACHE_CONF={directory}/sccache.toml", "RUSTC_WRAPPER=sccache",
    ]

for mode in ["missing-binary", "failed-start"]:
    result, directory, env_file, output = run_case(mode, mode=mode)
    assert result.returncode != 0, mode
    assert not (directory / "started").exists(), mode
    assert env_file.read_text() == "" and output.read_text() == "", mode

for key in inputs:
    result, directory, env_file, output = run_case("missing-" + key, overrides={key: ""})
    assert result.returncode != 0, key
    assert not (directory / "started").exists(), key
    assert env_file.read_text() == "" and output.read_text() == "", key

result, directory, env_file, output = run_case("unsupported", architecture="ppc64")
assert result.returncode != 0 and not (directory / "started").exists()
assert env_file.read_text() == "" and output.read_text() == ""

# Startup alone must not authorize reporting when compiler exports could not be written.
result, directory, _, output = run_case("export-failure", export_failure=True)
assert result.returncode != 0 and (directory / "started").exists()
assert output.read_text() == ""
PY

echo "setup-r2-sccache-test: ok"
