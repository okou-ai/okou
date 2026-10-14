#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../../.." && pwd)
python3 "$REPO_ROOT/crates/runner/tests/behavior/tests/runner-behavior-exec-inventory-test.py"
