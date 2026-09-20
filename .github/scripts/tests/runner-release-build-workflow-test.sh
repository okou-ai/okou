#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RELEASE_WORKFLOW="${REPO_ROOT}/.github/workflows/release-please.yml"
BUILD_WORKFLOW="${REPO_ROOT}/.github/workflows/runner-release-build.yml"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

command -v yq >/dev/null || fail "yq is required"
release_json=$(yq -o=json '.' "$RELEASE_WORKFLOW")
build_json=$(yq -o=json '.' "$BUILD_WORKFLOW")

jq -e '
  .jobs["build-runner-release-assets"] as $job |
  $job["runs-on"] == "ubuntu-latest-8-cores" and
  $job.container.image == "ghcr.io/vm0-ai/vm0-toolchain-rust:20260825" and
  ($job | has("environment") | not) and
  $job.strategy.matrix.target == [
    "aarch64-unknown-linux-musl",
    "x86_64-unknown-linux-musl"
  ] and
  any($job.steps[];
    .id == "target-metadata" and
    (.run | contains("runner_image_cache_suffix")) and
    (.run | contains("runner_image_sccache_architecture")) and
    (.run | contains("sccache_architecture=$sccache_architecture"))
  ) and
  any($job.steps[];
    .name == "Setup R2 sccache" and
    .uses == "./.github/actions/setup-r2-sccache" and
    .with.architecture == "${{ steps.target-metadata.outputs.sccache_architecture }}" and
    .with["r2-access-key-id"] == "${{ secrets.R2_ACCESS_KEY_ID }}" and
    .with["r2-secret-access-key"] == "${{ secrets.R2_SECRET_ACCESS_KEY }}" and
    .with["r2-account-id"] == "${{ vars.R2_ACCOUNT_ID }}" and
    .with["r2-bucket-name"] == "${{ vars.R2_USER_STORAGES_BUCKET_NAME }}"
  ) and
  any($job.steps[];
    .uses == "Swatinem/rust-cache@v2" and
    .with.workspaces == "crates -> target" and
    .with["shared-key"] == "${{ steps.target-metadata.outputs.cache_suffix }}-release" and
    (.with["save-if"] | contains("github.ref == ")) and
    (.with["save-if"] | contains("refs/heads/main"))
  ) and
  any($job.steps[];
    .name == "Cross-compile guest binaries for ${{ matrix.target }}" and
    .env.TARGET_TRIPLE == "${{ matrix.target }}" and
    .run == ".github/scripts/runner-release-build.sh guests"
  ) and
  any($job.steps[];
    .name == "Cross-compile runner with embedded guests for ${{ matrix.target }}" and
    .env.TARGET_TRIPLE == "${{ matrix.target }}" and
    .run == ".github/scripts/runner-release-build.sh runner"
  ) and
  any($job.steps[]; .name == "Notify Slack - Starting") and
  any($job.steps[]; .name == "Upload runner binary to GitHub Release") and
  any($job.steps[]; .name == "Notify Slack - Success") and
  any($job.steps[]; .name == "Notify Slack - Failure")
' <<<"$release_json" >/dev/null || fail "production release build must preserve cache, compilation, and release effects"

jq -e '
  .jobs["resolve-image-cache"] as $resolve |
  .jobs["build-runner-production"] as $production |
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
    .name == "Decrypt R2 image cache credentials" and
    .env._ENC_AK == "${{ needs.resolve-image-cache.outputs.r2-access-key-id }}" and
    .env._ENC_SK == "${{ needs.resolve-image-cache.outputs.r2-secret-access-key }}"
  ) and
  any($production.steps[];
    .name == "Build rootfs and snapshot on production hosts" and
    .env.R2_ACCOUNT_ID == "${{ needs.resolve-image-cache.outputs.r2-account-id }}" and
    .env.R2_USER_STORAGES_BUCKET_NAME == "${{ needs.resolve-image-cache.outputs.r2-bucket }}"
  )
' <<<"$release_json" >/dev/null || fail "environment-bound production image builds must retain the repo-level R2 handoff"

jq -e '
  .permissions == {"contents":"read"} and
  .jobs.build as $job |
  $job["runs-on"] == "ubuntu-latest-8-cores" and
  $job["timeout-minutes"] == 20 and
  $job.container.image == "ghcr.io/vm0-ai/vm0-toolchain-rust:20260825" and
  ($job | has("environment") | not) and
  ($job.if | contains("github.event_name == ")) and
  ($job.if | contains("workflow_dispatch")) and
  ($job.if | contains("github.event.pull_request.head.repo.full_name == github.repository")) and
  $job.strategy.matrix.target == [
    "aarch64-unknown-linux-musl",
    "x86_64-unknown-linux-musl"
  ] and
  any($job.steps[];
    .name == "Setup R2 sccache" and
    .uses == "./.github/actions/setup-r2-sccache" and
    .with.architecture == "${{ steps.target-metadata.outputs.sccache_architecture }}" and
    .with["r2-access-key-id"] == "${{ secrets.R2_ACCESS_KEY_ID }}" and
    .with["r2-secret-access-key"] == "${{ secrets.R2_SECRET_ACCESS_KEY }}" and
    .with["r2-account-id"] == "${{ vars.R2_ACCOUNT_ID }}" and
    .with["r2-bucket-name"] == "${{ vars.R2_USER_STORAGES_BUCKET_NAME }}"
  ) and
  any($job.steps[];
    .uses == "Swatinem/rust-cache@v2" and
    .with.workspaces == "crates -> target" and
    .with["shared-key"] == "${{ steps.target-metadata.outputs.cache_suffix }}-release" and
    .with["save-if"] == "false"
  ) and
  any($job.steps[]; .run == ".github/scripts/runner-release-build.sh guests") and
  any($job.steps[]; .run == ".github/scripts/runner-release-build.sh runner") and
  any($job.steps[]; .name == "Validate Runner release binary") and
  any($job.steps[]; .name == "Report sccache statistics" and .if == "${{ always() }}")
' <<<"$build_json" >/dev/null || fail "build-only workflow must preserve release inputs without production authority"

if jq -e '
  any(.jobs.build.steps[]?;
    ((.uses // "") | test("slack|upload-artifact"; "i")) or
    ((.name // "") | test("slack|upload|deploy|promote|provision"; "i"))
  )
' <<<"$build_json" >/dev/null; then
  fail "build-only workflow must not upload, notify, provision, promote, or deploy"
fi

release_runner=$(jq -r '.jobs["build-runner-release-assets"]["runs-on"]' <<<"$release_json")
build_runner=$(jq -r '.jobs.build["runs-on"]' <<<"$build_json")
[ "$release_runner" = "$build_runner" ] || fail "release and build-only workflows must use the same runner"

release_container=$(jq -r '.jobs["build-runner-release-assets"].container.image' <<<"$release_json")
build_container=$(jq -r '.jobs.build.container.image' <<<"$build_json")
[ "$release_container" = "$build_container" ] || fail "release and build-only workflows must use the same toolchain"

release_targets=$(jq -c '.jobs["build-runner-release-assets"].strategy.matrix.target' <<<"$release_json")
build_targets=$(jq -c '.jobs.build.strategy.matrix.target' <<<"$build_json")
[ "$release_targets" = "$build_targets" ] || fail "release and build-only workflows must use the same targets"

echo "runner release build workflow tests passed"
