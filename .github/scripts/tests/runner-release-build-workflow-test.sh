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

asset_resolver=$(jq -er '
  .jobs["build-runner-production"].steps[] | select(.id == "runner-asset") | .run
' <<<"$release_json")

jq -e '
  any(.jobs["build-runner-production"].steps[];
    .env.RUNNER_ASSET_URL == "${{ steps.runner-asset.outputs.url }}" and
    .env.RUNNER_ASSET_CHECKSUM == "${{ steps.runner-asset.outputs.checksum }}" and
    (.run | contains("runner_asset_url=$" + "{RUNNER_ASSET_URL}")) and
    (.run | contains("runner_asset_checksum=$" + "{RUNNER_ASSET_CHECKSUM}"))
  )
' <<<"$release_json" >/dev/null || fail "production staging must receive the resolved asset URL and checksum"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$REPO_ROOT"
export GITHUB_OUTPUT="$tmp/outputs" VERSION=1.2.3 GH_TOKEN=fixture
export GITHUB_REPOSITORY=okou-ai/okou GITHUB_SERVER_URL=https://github.com
export RELEASE_API_FIXTURE="$tmp/release.json"

curl() {
  [[ "${!#}" == "https://api.github.com/repos/okou-ai/okou/releases/tags/runner-rs-v1.2.3" ]] || return 1
  cat "$RELEASE_API_FIXTURE"
}
export -f curl

sha_x86=$(printf '%064d' 1)
sha_arm=$(printf '%064d' 2)
jq -n --arg x86 "$sha_x86" --arg arm "$sha_arm" '{
  assets: [
    {name: "runner-v1.2.3-aarch64-linux", digest: ("sha256:" + $arm)},
    {name: "runner-v1.2.3-x86_64-linux", digest: ("sha256:" + $x86)}
  ]
}' >"$RELEASE_API_FIXTURE"

verify_asset_output() {
  local arch=$1 digest=$2
  : >"$GITHUB_OUTPUT"
  TARGET_TRIPLE="$arch-unknown-linux-musl" bash -c "$asset_resolver"
  diff -u "$GITHUB_OUTPUT" <(printf 'url=https://github.com/okou-ai/okou/releases/download/runner-rs-v1.2.3/runner-v1.2.3-%s-linux\nchecksum=sha256:%s\n' "$arch" "$digest")
}
verify_asset_output x86_64 "$sha_x86"
verify_asset_output aarch64 "$sha_arm"

for broken in '{"assets":[]}' '{"assets":[{"name":"runner-v1.2.3-x86_64-linux","digest":null}]}'; do
  printf '%s\n' "$broken" >"$RELEASE_API_FIXTURE"
  : >"$GITHUB_OUTPUT"
  if TARGET_TRIPLE=x86_64-unknown-linux-musl bash -c "$asset_resolver" >"$tmp/error"; then
    fail "expected the release step to reject malformed asset metadata"
  fi
  [[ ! -s "$GITHUB_OUTPUT" ]] || fail "invalid release metadata must not authorize a host download"
done

echo "runner release build workflow tests passed"
