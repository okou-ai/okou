#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
exec python3 -B "$repo_root/.github/scripts/tests/cleanup-metal-test.py"
