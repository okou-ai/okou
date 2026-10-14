#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
python3 "$repo_root/ops/kms-migration-32264/tests/kms-production-exit-check-test.py"
