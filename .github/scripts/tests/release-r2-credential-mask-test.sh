#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

yq -r '.jobs.build-runner-production.steps[] | select(.name == "Decrypt R2 image cache credentials") | .run' \
  "$repo_root/.github/workflows/release-please.yml" > "$tmp/decrypt.sh"

# Run the production step with encrypted fixtures and join the mask commands and
# environment-file writes into one transcript to verify their publication order.
python3 - "$tmp/decrypt.sh" <<'PY'
import os
from pathlib import Path
import subprocess
import sys

step = Path(sys.argv[1])
access_key = "fixture-r2-access-key"
secret_key = "fixture-r2-secret-key"
environment = {**os.environ, "_PASSPHRASE": "fixture-passphrase"}


def encrypt(value):
    result = subprocess.run(
        ["openssl", "enc", "-aes-128-cbc", "-pbkdf2", "-pass", "env:_PASSPHRASE", "-a", "-A"],
        input=value, text=True, capture_output=True, env=environment, check=True,
    )
    return result.stdout


def decrypt(access, secret):
    transcript = step.with_suffix(".log")
    transcript.write_text("")
    with transcript.open("a") as output:
        result = subprocess.run(
            ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", step],
            env={
                **environment, "_ENC_AK": encrypt(access), "_ENC_SK": encrypt(secret),
                "GITHUB_ENV": str(transcript),
            },
            text=True, stdout=output, stderr=subprocess.PIPE,
        )
    result.stdout = transcript.read_text()
    return result


result = decrypt(access_key, secret_key)
assert result.returncode == 0, result.stderr
lines = result.stdout.splitlines()
for key, value in [("R2_ACCESS_KEY_ID", access_key), ("R2_SECRET_ACCESS_KEY", secret_key)]:
    mask = f"::add-mask::{value}"
    exported = f"{key}={value}"
    assert mask in lines, f"{key} was not registered for masking"
    assert exported in lines, f"{key} was not exported to the build"
    assert lines.index(mask) < lines.index(exported), f"{key} was published before masking"
    assert all(value not in line or line in [mask, exported] for line in lines)

for access, secret in [("", secret_key), (access_key, "")]:
    result = decrypt(access, secret)
    assert result.returncode != 0, "empty credentials must fail the step"
    assert "R2_ACCESS_KEY_ID=" not in result.stdout
    assert "R2_SECRET_ACCESS_KEY=" not in result.stdout
PY

echo "release-r2-credential-mask-test: ok"
