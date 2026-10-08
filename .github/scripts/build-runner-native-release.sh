#!/usr/bin/env bash
# Pre-merge distribution conformance only; no release, cache publication or deploy.
set -euo pipefail
# Exact caller-scoped trust survives the container's nested Git processes; no
# repository/global config write and no trust for unrelated checkouts.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$repo_root"
[[ $(git -C "$repo_root" rev-parse --show-toplevel) == "$repo_root" ]]
cd "$repo_root"
: "${SOURCE_SHA:?missing release source SHA}" "${TARGET_TRIPLE:?missing release target}" \
  "${RUNNER_RELEASE_TOOLCHAIN_IMAGE:?missing release toolchain image}"
. .github/scripts/runner-image-target.sh
runner_image_validate_target "$TARGET_TRIPLE"
# Share only the canonical Runner toolchain; preserve the distinct release
# recipe/profile below, never override runner-binary-build/contract.env (ci).
output="$PWD/crates/target/f5-release-input"
export CARGO_TARGET_DIR="$PWD/crates/target"
mkdir -p "$CARGO_TARGET_DIR"
python3 -B .github/scripts/runner-native-release.py prepare "$output" \
  --source-sha "$SOURCE_SHA" --target "$TARGET_TRIPLE" \
  --toolchain-image "$RUNNER_RELEASE_TOOLCHAIN_IMAGE"
. .github/scripts/runner-guest-binaries.sh
runner_guest_binaries_load
# Same actual release two-phase recipe and target directory, with locked inputs
# and retained real compiler JSON. Compiler caching may reuse valid same-input
# outputs; no ci Runner object/digest is reused or relabeled as release.
guest_args=()
for package in "${RUNNER_GUEST_PACKAGES[@]}"; do guest_args+=( -p "$package" ); done
(
  cd crates
  CARGO_INCREMENTAL=0 cargo build --locked --release --target "$TARGET_TRIPLE" \
    "${guest_args[@]}" --message-format=json-render-diagnostics > "$output/guest-compiler.json"
  target_dir="$PWD/target/$TARGET_TRIPLE/release"
  guest_env=()
  for index in "${!RUNNER_GUEST_BINARIES[@]}"; do
    guest_env+=( "${RUNNER_GUEST_PATH_ENVS[$index]}=$target_dir/${RUNNER_GUEST_BINARIES[$index]}" )
  done
  CARGO_INCREMENTAL=0 env "${guest_env[@]}" \
    GUEST_CLI_PATH="$(dirname "$PWD")/runner-cli-intermediate/package.tgz" \
    GUEST_CLI_MANIFEST_PATH="$(dirname "$PWD")/runner-cli-intermediate/manifest.json" \
    cargo build --locked --release --target "$TARGET_TRIPLE" -p runner \
      --message-format=json-render-diagnostics > "$output/compiler.json"
)
python3 -B .github/scripts/runner-native-release.py finish "$output"
