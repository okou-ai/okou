#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Paths are resolved from this script at runtime.
# shellcheck disable=SC1091
# shellcheck source=.github/scripts/runner-image-target.sh
. "${SCRIPT_DIR}/runner-image-target.sh"
# Paths are resolved from this script at runtime.
# shellcheck disable=SC1091
# shellcheck source=.github/scripts/runner-guest-binaries.sh
. "${SCRIPT_DIR}/runner-guest-binaries.sh"

mode="${1:-}"
case "$mode" in
  guests|runner) ;;
  *)
    echo "usage: $0 <guests|runner>" >&2
    exit 2
    ;;
esac

target="${TARGET_TRIPLE:-}"
runner_image_validate_target "$target"
runner_guest_binaries_load

case "$mode" in
  guests)
    guest_cargo_args=()
    for package in "${RUNNER_GUEST_PACKAGES[@]}"; do
      guest_cargo_args+=("-p" "$package")
    done

    cd "${REPO_ROOT}/crates"
    cargo build --release --target "$target" "${guest_cargo_args[@]}"
    ;;
  runner)
    cd "${REPO_ROOT}/crates"
    target_dir="target/${target}/release"
    guest_env=()
    for index in "${!RUNNER_GUEST_BINARIES[@]}"; do
      guest_env+=("${RUNNER_GUEST_PATH_ENVS[$index]}=${target_dir}/${RUNNER_GUEST_BINARIES[$index]}")
    done

    env "${guest_env[@]}" cargo build --release --target "$target" -p runner
    ;;
esac
