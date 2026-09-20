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
  .jobs["build-runner-release-assets"] as $job |
  $job["runs-on"] == "ubuntu-latest-8-cores" and
  $job.container.image == "ghcr.io/${{ github.repository_owner }}/vm0-toolchain-rust:20260825" and
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
    (.run | contains("runner_guest_binaries_load")) and
    (.run | contains("cargo build --release --target \"$TARGET_TRIPLE\" \"${guest_cargo_args[@]}\""))
  ) and
  any($job.steps[];
    .name == "Cross-compile runner with embedded guests for ${{ matrix.target }}" and
    .env.TARGET_TRIPLE == "${{ matrix.target }}" and
    (.run | contains("runner_guest_binaries_load")) and
    (.run | contains("env \"${guest_env[@]}\" cargo build --release --target \"$TARGET_TRIPLE\" -p runner"))
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

echo "runner release build workflow tests passed"
