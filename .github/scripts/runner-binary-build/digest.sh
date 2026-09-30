#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
. "${SCRIPT_DIR}/contract.env"

emit() {
  local key=$1 value=$2
  printf '%s=%s\n' "$key" "$value"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT"
  fi
}

target="${1:-${TARGET_TRIPLE:-}}"
case "$target" in
  aarch64-unknown-linux-musl|x86_64-unknown-linux-musl) ;;
  "") echo "missing runner binary target" >&2; exit 2 ;;
  *) echo "unsupported runner binary target: ${target}" >&2; exit 2 ;;
esac

revision="${RUNNER_BINARY_GIT_REVISION:-HEAD}"
source_sha=$(git -C "$REPO_ROOT" rev-parse --verify "${revision}^{commit}")
cli_package="${GUEST_CLI_PATH:-}"
if [ -n "$cli_package" ]; then
  if [[ "$cli_package" != /* ]]; then
    cli_package="${REPO_ROOT}/${cli_package}"
  fi
  cli_manifest="$(dirname "$cli_package")/manifest.json"
  for file in "$cli_package" "$cli_manifest"; do
    if [ ! -f "$file" ] || [ ! -s "$file" ]; then
      echo "runner CLI build input is missing or empty: ${file}" >&2
      exit 1
    fi
  done
fi
binary_input_digest=$(
  {
    printf '%s\0%s\0' "$RUNNER_BINARY_INPUT_SCHEMA_VERSION" "$target"
    "${SCRIPT_DIR}/context.sh" inventory "$REPO_ROOT" "$revision" || exit 1
    if [ -n "$cli_package" ]; then
      printf '%s\0' "$source_sha"
      sha256sum "$cli_package" "$cli_manifest" | awk '{print $1}'
    else
      printf 'local-build-without-cli\0'
    fi
  } | sha256sum | awk '{print $1}'
)

emit "binary-input-digest" "$binary_input_digest"
emit "toolchain-image" "$RUNNER_BINARY_TOOLCHAIN_IMAGE"
