#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WORKFLOW="${REPO_ROOT}/.github/workflows/docker-toolchain.yml"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

command -v yq >/dev/null || fail "yq is required"
workflow_json=$(yq -o=json '.' "$WORKFLOW")

jq -e '
  .jobs["detect-toolchain-changes"] as $detect |
  $detect.outputs["toolchain-changed"] == "${{ steps.detect.outputs.toolchain-changed }}" and
  any($detect.steps[]?;
    ((.uses // "") | startswith("actions/checkout@")) and
    .with["fetch-depth"] == 2
  ) and
  any($detect.steps[]?;
    .id == "detect" and
    (.run | contains(".github/scripts/changed-base-ref.sh")) and
    (.run | contains("git diff --quiet \"$BASE_REF\" HEAD -- docker/toolchain/"))
  )
' <<<"$workflow_json" >/dev/null || fail "toolchain image changes must be detected from docker/toolchain only"

jq -e '
  .jobs.toolchain as $toolchain |
  ($toolchain.needs | index("detect-toolchain-changes")) != null and
  ($toolchain.if | contains("needs.detect-toolchain-changes.outputs.toolchain-changed == '\''true'\''")) and
  (.jobs["devcontainer-scripts"].needs == null)
' <<<"$workflow_json" >/dev/null || fail "image builds must be gated independently from devcontainer script checks"

echo "docker-toolchain-workflow-test: ok"
