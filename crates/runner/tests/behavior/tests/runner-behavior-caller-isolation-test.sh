#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../../.." && pwd)
python3 "$REPO_ROOT/crates/runner/tests/caller_isolation_native/test_fixture.py"
