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
git -C "$REPO_ROOT" rev-parse --verify "${revision}^{commit}" >/dev/null
cli_package="${GUEST_CLI_PATH:-}"
cli_manifest="${GUEST_CLI_MANIFEST_PATH:-}"
if { [ -n "$cli_package" ] && [ -z "$cli_manifest" ]; } ||
   { [ -z "$cli_package" ] && [ -n "$cli_manifest" ]; }; then
  echo "GUEST_CLI_PATH and GUEST_CLI_MANIFEST_PATH must be provided together" >&2
  exit 2
fi
if [ -n "$cli_package" ]; then
  if [[ "$cli_package" != /* ]]; then
    cli_package="${REPO_ROOT}/${cli_package}"
  fi
  if [[ "$cli_manifest" != /* ]]; then
    cli_manifest="${REPO_ROOT}/${cli_manifest}"
  fi
  for file in "$cli_package" "$cli_manifest"; do
    if [ ! -f "$file" ] || [ -L "$file" ] || [ ! -s "$file" ]; then
      echo "runner CLI build input is not a nonempty regular file: ${file}" >&2
      exit 1
    fi
  done

  cli_size=$(stat -c '%s' "$cli_package")
  manifest_size=$(stat -c '%s' "$cli_manifest")
  # Match the file and identity constraints in crates/runner/build.rs.
  if [ "$cli_size" -gt $((64 * 1024 * 1024)) ] || [ "$manifest_size" -gt $((16 * 1024)) ]; then
    echo "runner CLI build input exceeds its size limit" >&2
    exit 1
  fi
  cli_sha256=$(sha256sum "$cli_package" | awk '{print $1}')
  if ! cli_identity=$(jq -sceS --arg sha "$cli_sha256" --argjson size "$cli_size" '
    def release_version:
      type == "string" and
      test("\\A(0|[1-9][0-9]{0,9})\\.(0|[1-9][0-9]{0,9})\\.(0|[1-9][0-9]{0,9})\\z");
    if length == 1 then .[0] else error("expected one CLI manifest") end |
    if (
      .version == 1 and
      .package.path == "package.tgz" and
      .package.sha256 == $sha and
      .package.size == $size and
      (.versions.cli | release_version) and
      (.versions.piAgentRuntime | release_version) and
      (.versions.piSdk | type == "string" and
        (split("+okou.") | length == 2 and
          (.[0] | release_version) and
          (.[1] | test("\\A[0-9a-f]{12}\\z")))) and
      (.sessionConstruction.digest | type == "string" and test("\\A[0-9a-f]{64}\\z"))
    ) then {
      version,
      package: {path: .package.path, sha256: .package.sha256, size: .package.size},
      versions: {
        cli: .versions.cli,
        piAgentRuntime: .versions.piAgentRuntime,
        piSdk: .versions.piSdk
      },
      sessionConstruction: {digest: .sessionConstruction.digest}
    } else error("invalid CLI build identity") end
  ' "$cli_manifest"); then
    echo "runner CLI manifest is invalid or does not match the package: ${cli_manifest}" >&2
    exit 1
  fi
fi
binary_input_digest=$(
  {
    printf '%s\0%s\0' "$RUNNER_BINARY_INPUT_SCHEMA_VERSION" "$target"
    "${SCRIPT_DIR}/context.sh" inventory "$REPO_ROOT" "$revision" || exit 1
    if [ -n "$cli_package" ]; then
      # Only package bytes and CliManifest fields consumed by Runner compilation
      # affect the binary; commit provenance and JSON serialization do not.
      printf 'bundled-cli\0%s\0%s\0' "$cli_sha256" "$cli_identity"
    else
      printf 'local-build-without-cli\0'
    fi
  } | sha256sum | awk '{print $1}'
)

emit "binary-input-digest" "$binary_input_digest"
emit "toolchain-image" "$RUNNER_BINARY_TOOLCHAIN_IMAGE"
