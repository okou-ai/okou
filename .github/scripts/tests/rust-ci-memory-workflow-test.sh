#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CRATES_WORKFLOW="${REPO_ROOT}/.github/workflows/crates.yml"
RUNNER_IMAGE_WORKFLOW="${REPO_ROOT}/.github/workflows/runner-image.yml"
ACTION="${REPO_ROOT}/.github/actions/report-memory-peak/action.yml"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

command -v yq >/dev/null || fail "yq is required"
crates_json=$(yq -o=json '.' "$CRATES_WORKFLOW")
runner_image_json=$(yq -o=json '.' "$RUNNER_IMAGE_WORKFLOW")
action_json=$(yq -o=json '.' "$ACTION")

jq -e '
  . as $workflow |
  ["check", "coverage", "runner-firewall-contract-test", "host-cpu-fairness-build", "guest-rpc-firecracker-build", "nbd-cow-test"] |
  all(.[];
    . as $job |
    ($workflow.jobs[$job].steps[-1] |
      .name == "Report peak memory" and
      .if == "always()" and
      .["continue-on-error"] == true and
      .uses == "./.github/actions/report-memory-peak"
    )
  )
' <<<"$crates_json" >/dev/null || fail "all Rust compilation jobs in crates.yml must report peak memory"

jq -e '
  .jobs.compile.steps[-1] |
    .name == "Report peak memory" and
    .if == "always()" and
    .["continue-on-error"] == true and
    .uses == "./.github/actions/report-memory-peak"
' <<<"$runner_image_json" >/dev/null || fail "runner binary compilation must report peak memory"

jq -e '
  .runs.using == "composite" and
  any(.runs.steps[];
    .shell == "bash" and
    .env.OKOU_MEMORY_REPORT_LABEL == "${{ inputs.job-label }}" and
    .run == "bash \"$GITHUB_ACTION_PATH/report.sh\""
  )
' <<<"$action_json" >/dev/null || fail "peak memory action must run the bundled cgroup reporter"

jq -e '
  any(.jobs.detect.steps[]?;
    .id == "detect" and
    (.run | contains(".github/actions/(setup-ssh-tunnel|provision|report-memory-peak)/"))
  )
' <<<"$crates_json" >/dev/null || fail "crates change detection must include the peak memory action"

echo "rust-ci-memory-workflow-test: ok"
