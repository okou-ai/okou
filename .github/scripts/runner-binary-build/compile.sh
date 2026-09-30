#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
CRATES_DIR="${SOURCE_ROOT}/crates"
. "${SCRIPT_DIR}/contract.env"

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 2
  fi
}

require_env TARGET_TRIPLE
require_env CARGO_TARGET_DIR
require_env RUNNER_BINARY_ACTUAL_TOOLCHAIN_IMAGE
require_env RUNNER_BINARY_INPUT_DIGEST
require_env RUNNER_BINARY_METADATA_PATH

case "$TARGET_TRIPLE" in
  aarch64-unknown-linux-musl|x86_64-unknown-linux-musl) ;;
  *) echo "unsupported runner binary target: ${TARGET_TRIPLE}" >&2; exit 2 ;;
esac
if [ "$RUNNER_BINARY_ACTUAL_TOOLCHAIN_IMAGE" != "$RUNNER_BINARY_TOOLCHAIN_IMAGE" ]; then
  echo "runner binary toolchain mismatch: ${RUNNER_BINARY_ACTUAL_TOOLCHAIN_IMAGE} != ${RUNNER_BINARY_TOOLCHAIN_IMAGE}" >&2
  exit 2
fi
if [[ ! "$RUNNER_BINARY_INPUT_DIGEST" =~ ^[0-9a-f]{64}$ ]]; then
  echo "invalid runner binary input digest: ${RUNNER_BINARY_INPUT_DIGEST}" >&2
  exit 2
fi
if [ -n "${RUNNER_CLI_PACKAGE_PATH:-}" ]; then
  if [ ! -f "$RUNNER_CLI_PACKAGE_PATH" ] || [ ! -s "$RUNNER_CLI_PACKAGE_PATH" ]; then
    echo "runner CLI package is missing or empty: ${RUNNER_CLI_PACKAGE_PATH}" >&2
    exit 1
  fi
elif [ "${RUNNER_CLI_REQUIRED:-false}" = "true" ]; then
  echo "runner compilation requires a CLI package" >&2
  exit 1
fi

inventory="${CRATES_DIR}/runner/guest-binaries.json"
if ! jq -e '
  type == "array" and length > 0 and
  all(.[];
    type == "object" and
    (.package | type == "string" and length > 0) and
    (.binary | type == "string" and length > 0) and
    (.pathEnv | type == "string" and test("^[A-Z][A-Z0-9_]*$"))) and
  ([.[].package] | length == (unique | length)) and
  ([.[].binary] | length == (unique | length)) and
  ([.[].pathEnv] | length == (unique | length))
' "$inventory" >/dev/null; then
  echo "invalid runner guest binary inventory: ${inventory}" >&2
  exit 1
fi

guest_cargo_args=()
guest_env=()
guest_binaries=()
while IFS=$'\t' read -r package binary path_env; do
  guest_cargo_args+=("-p" "$package")
  guest_env+=("${path_env}=${CARGO_TARGET_DIR}/${TARGET_TRIPLE}/${RUNNER_BINARY_PROFILE}/${binary}")
  guest_binaries+=("$binary")
done < <(jq -r '.[] | [.package, .binary, .pathEnv] | @tsv' "$inventory")

echo "=== Cross-compiling guest binaries for ${TARGET_TRIPLE} ==="
(
  cd "$CRATES_DIR"
  CARGO_INCREMENTAL=0 cargo build \
    --locked \
    --profile "$RUNNER_BINARY_PROFILE" \
    --target "$TARGET_TRIPLE" \
    "${guest_cargo_args[@]}"
)

echo "=== Cross-compiling runner with embedded guests and CLI for ${TARGET_TRIPLE} ==="
(
  cd "$CRATES_DIR"
  CARGO_INCREMENTAL=0 env "${guest_env[@]}" \
    RUNNER_CLI_PACKAGE_PATH="${RUNNER_CLI_PACKAGE_PATH:-}" \
    RUNNER_CLI_REQUIRED="${RUNNER_CLI_REQUIRED:-}" cargo build \
    --locked \
    --profile "$RUNNER_BINARY_PROFILE" \
    --target "$TARGET_TRIPLE" \
    -p runner
)

output_dir="${CARGO_TARGET_DIR}/${TARGET_TRIPLE}/${RUNNER_BINARY_PROFILE}"
runner_path="${output_dir}/runner"
runner_sha=$(sha256sum "$runner_path" | awk '{print $1}')
runner_size=$(stat -c '%s' "$runner_path")
guest_sha_json=$(jq -n '{}')
for binary in "${guest_binaries[@]}"; do
  guest_sha=$(sha256sum "${output_dir}/${binary}" | awk '{print $1}')
  guest_sha_json=$(jq -c \
    --arg binary "$binary" \
    --arg sha "$guest_sha" \
    '. + {($binary): $sha}' \
    <<<"$guest_sha_json")
done

metadata_tmp="${RUNNER_BINARY_METADATA_PATH}.tmp"
jq -n \
  --arg binary_input_digest "$RUNNER_BINARY_INPUT_DIGEST" \
  --arg target "$TARGET_TRIPLE" \
  --arg toolchain_image "$RUNNER_BINARY_TOOLCHAIN_IMAGE" \
  --arg runner_sha "$runner_sha" \
  --argjson runner_size "$runner_size" \
  --argjson guests "$guest_sha_json" \
  '{
    schemaVersion: 1,
    binaryInputDigest: $binary_input_digest,
    target: $target,
    toolchainImage: $toolchain_image,
    runnerSha256: $runner_sha,
    runnerSizeBytes: $runner_size,
    guestSha256: $guests
  }' > "$metadata_tmp"
mv -f "$metadata_tmp" "$RUNNER_BINARY_METADATA_PATH"
