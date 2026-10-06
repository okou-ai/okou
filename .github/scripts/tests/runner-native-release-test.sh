#!/usr/bin/env bash
# Public workflow/input regressions only. No compiler, Runner or helper runs.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
command -v yq >/dev/null || { echo 'yq is required' >&2; exit 1; }
mkdir -p crates/target
context=$(mktemp -d "$PWD/crates/target/native-release-tests.XXXXXX")
trap 'rm -rf "$context"' EXIT
yq -o=json '.' .github/workflows/runner-image.yml > "$context/workflow.json"
RUNNER_NATIVE_WORKFLOW_JSON="$context/workflow.json" python3 -B .github/scripts/tests/test-runner-native-release.py
