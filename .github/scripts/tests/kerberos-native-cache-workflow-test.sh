#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
yq -o=json '.' "$repo_root/.github/workflows/crates.yml" | \
  python3 "$repo_root/.github/scripts/tests/kerberos-native-cache-workflow-test.py"
