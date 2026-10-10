#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
python3 "$REPO_ROOT/.github/scripts/tests/toolchain-version-test.py"
sh "$REPO_ROOT/scripts/toolchain-version.sh" UV_VERSION "$REPO_ROOT/crates/runner/scripts/build-template.sh"
