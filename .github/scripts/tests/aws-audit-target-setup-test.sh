#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
sdk_dir="$(mktemp -d)"
trap 'rm -rf "$sdk_dir"' EXIT
python3 -m pip install --disable-pip-version-check --no-input --quiet \
  --target "$sdk_dir" boto3==1.40.0
PYTHONPATH="$sdk_dir${PYTHONPATH:+:$PYTHONPATH}" \
  python3 "$repo_root/ops/aws-audit-32264/tests/aws-audit-target-setup-test.py"
