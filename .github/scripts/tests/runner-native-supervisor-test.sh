#!/usr/bin/env bash
# Admission/graph regressions only, never compiler or runtime evidence.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
command -v yq >/dev/null || { echo 'yq is required' >&2; exit 1; }
mkdir -p crates/target
context=$(mktemp -d "$PWD/crates/target/native-supervisor-tests.XXXXXX")
trap 'rm -rf "$context"' EXIT
yq -o=json '.' .github/workflows/runner-image.yml > "$context/workflow.json"
RUNNER_NATIVE_WORKFLOW_JSON="$context/workflow.json" python3 -B .github/scripts/tests/test-runner-native-supervisor.py
