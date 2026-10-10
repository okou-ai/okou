#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WORKFLOW="${REPO_ROOT}/.github/workflows/docker-toolchain.yml"
PUBLISH_WORKFLOW="${REPO_ROOT}/.github/workflows/docker-toolchain-publish.yml"

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
    (.run | contains("git diff --quiet \"$BASE_REF\" HEAD --")) and
    (.run | contains("docker/toolchain/")) and
    (.run | contains("crates/runner/scripts/build-template.sh")) and
    (.run | contains("scripts/toolchain-version.sh"))
  )
' <<<"$workflow_json" >/dev/null || fail "toolchain image changes must include canonical version inputs"

jq -e '
  .jobs.toolchain as $toolchain |
  ($toolchain.needs | index("detect-toolchain-changes")) != null and
  ($toolchain.if | contains("needs.detect-toolchain-changes.outputs.toolchain-changed == '\''true'\''")) and
  (.jobs["devcontainer-scripts"].needs == null)
' <<<"$workflow_json" >/dev/null || fail "image builds must be gated independently from devcontainer script checks"

publish_json=$(yq -o=json '.' "$PUBLISH_WORKFLOW")
for json in "$workflow_json" "$publish_json"; do
  jq -e '
    [.jobs[] | .steps[]? | select((.uses // "") | startswith("docker/build-push-action@"))] as $builds |
    ($builds | length) > 0 and
    all($builds[]; .with.context == "." and .with.file == "./docker/toolchain/Dockerfile") and
    ([.on[]?.paths[]?] | index("crates/runner/scripts/build-template.sh")) != null and
    ([.on[]?.paths[]?] | index("scripts/toolchain-version.sh")) != null
  ' <<<"$json" >/dev/null || fail "all image entry points must consume canonical version inputs"
done

echo "docker-toolchain-workflow-test: ok"
