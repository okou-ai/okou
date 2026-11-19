#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WORKFLOW="${REPO_ROOT}/.github/workflows/crates.yml"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

for command in jq yq; do
  command -v "$command" >/dev/null || fail "$command is required"
done

workflow_json=$(yq -o=json '.' "$WORKFLOW")

jq -e '
  [.jobs.coverage.steps[] | select(.uses == "./.github/actions/setup-r2-sccache")] as $setups |
  ($setups | length) == 1 and
  ($setups[0] |
    .if == "(github.event_name != '\''pull_request'\'' || (github.event.pull_request.user.login != '\''dependabot[bot]'\'' && github.event.pull_request.head.repo.full_name == github.repository))" and
    .with.architecture == "x86_64" and
    .with["r2-access-key-id"] == "${{ secrets.R2_ACCESS_KEY_ID }}" and
    .with["r2-secret-access-key"] == "${{ secrets.R2_SECRET_ACCESS_KEY }}" and
    .with["r2-account-id"] == "${{ vars.R2_ACCOUNT_ID }}" and
    .with["r2-bucket-name"] == "${{ vars.R2_USER_STORAGES_BUCKET_NAME }}"
  )
' <<<"$workflow_json" >/dev/null || fail "coverage must restrict R2 sccache credentials to trusted runs"

echo "rust-coverage-cache-workflow-test: ok"
