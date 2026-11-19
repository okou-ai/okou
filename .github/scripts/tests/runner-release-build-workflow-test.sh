#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RELEASE_WORKFLOW="${REPO_ROOT}/.github/workflows/release-please.yml"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

command -v yq >/dev/null || fail "yq is required"
release_json=$(yq -o=json '.' "$RELEASE_WORKFLOW")

jq -e '
  .jobs["resolve-image-cache"] as $resolve |
  .jobs["build-runner-production"] as $production |
  (.jobs["build-runner-release-assets"] | has("environment") | not) and
  ($resolve | has("environment") | not) and
  any($resolve.steps[];
    .id == "resolve" and
    .env.R2_ACCOUNT_ID == "${{ vars.R2_ACCOUNT_ID }}" and
    .env.R2_ACCESS_KEY_ID == "${{ secrets.R2_ACCESS_KEY_ID }}" and
    .env.R2_SECRET_ACCESS_KEY == "${{ secrets.R2_SECRET_ACCESS_KEY }}" and
    .env.R2_BUCKET == "${{ vars.R2_USER_STORAGES_BUCKET_NAME }}"
  ) and
  ($production.needs | index("resolve-image-cache")) != null and
  $production.environment == "production" and
  any($production.steps[];
    .env._ENC_AK == "${{ needs.resolve-image-cache.outputs.r2-access-key-id }}" and
    .env._ENC_SK == "${{ needs.resolve-image-cache.outputs.r2-secret-access-key }}"
  ) and
  any($production.steps[];
    .env.R2_ACCOUNT_ID == "${{ needs.resolve-image-cache.outputs.r2-account-id }}" and
    .env.R2_USER_STORAGES_BUCKET_NAME == "${{ needs.resolve-image-cache.outputs.r2-bucket }}"
  )
' <<<"$release_json" >/dev/null || fail "environment-bound production image builds must retain the repo-level R2 handoff"

echo "runner release build workflow tests passed"
