#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd -P)"
python3 "$repo_root/crates/kerberos-worker/tests/infrastructure/kerberos-native-cache-test.py"
