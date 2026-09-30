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

target="${TARGET_TRIPLE:-}"
case "$target" in
  aarch64-unknown-linux-musl|x86_64-unknown-linux-musl) ;;
  "") echo "missing runner binary target" >&2; exit 2 ;;
  *) echo "unsupported runner binary target: ${target}" >&2; exit 2 ;;
esac

revision="${RUNNER_BINARY_GIT_REVISION:-HEAD}"
source_sha=$(git -C "$REPO_ROOT" rev-parse --verify "${revision}^{commit}")
cli_package="${GUEST_CLI_PATH:-}"
cli_manifest="${GUEST_CLI_MANIFEST_PATH:-}"
if [ -n "$cli_package" ] && [[ "$cli_package" != /* ]]; then
  cli_package="${REPO_ROOT}/${cli_package}"
fi
if [ -n "$cli_manifest" ] && [[ "$cli_manifest" != /* ]]; then
  cli_manifest="${REPO_ROOT}/${cli_manifest}"
fi
cargo_target_dir="${CARGO_TARGET_DIR:-${REPO_ROOT}/crates/target}"
if [[ "$cargo_target_dir" != /* ]]; then
  cargo_target_dir="${REPO_ROOT}/${cargo_target_dir}"
fi
context_root="${RUNNER_BINARY_CONTEXT_ROOT:-${RUNNER_TEMP:-${cargo_target_dir}}/runner-binary-build-context-${target}}"
case "$context_root" in
  /|"$REPO_ROOT")
    echo "refusing unsafe runner binary context path: ${context_root}" >&2
    exit 2
    ;;
esac

materialize_temp_dir=""
cleanup_materialize() {
  if [ -n "$materialize_temp_dir" ]; then
    rm -rf "$materialize_temp_dir"
  fi
}

materialize() {
  local temp_parent temp_dir expected_inventory actual_inventory index_file
  temp_parent="${RUNNER_TEMP:-${cargo_target_dir}}"
  mkdir -p "$temp_parent"
  temp_dir=$(mktemp -d "${temp_parent}/runner-binary-materialize.XXXXXX")
  expected_inventory="${temp_dir}/expected.inventory"
  actual_inventory="${temp_dir}/actual.inventory"
  index_file="${temp_dir}/index"
  materialize_temp_dir=$temp_dir
  trap cleanup_materialize EXIT

  "${SCRIPT_DIR}/context.sh" inventory "$REPO_ROOT" "$revision" > "$expected_inventory"
  GIT_INDEX_FILE="$index_file" git -C "$REPO_ROOT" read-tree --empty
  GIT_INDEX_FILE="$index_file" git -C "$REPO_ROOT" update-index \
    -z --index-info < "$expected_inventory"
  while IFS= read -r -d '' record; do
    local metadata path mode object stage extra
    [[ "$record" == *$'\t'* ]] || {
      echo "malformed alternate-index entry" >&2
      exit 1
    }
    metadata=${record%%$'\t'*}
    path=${record#*$'\t'}
    extra=""
    IFS=' ' read -r mode object stage extra <<<"$metadata"
    [[ -z "$extra" && "$stage" == "0" ]] || {
      echo "unexpected alternate-index stage for ${path}" >&2
      exit 1
    }
    printf '%s blob %s\t%s\0' "$mode" "$object" "$path"
  done < <(
    GIT_INDEX_FILE="$index_file" git -C "$REPO_ROOT" ls-files --stage -z
  ) > "$actual_inventory"
  if ! cmp "$expected_inventory" "$actual_inventory"; then
    echo "alternate index does not match the runner binary inventory" >&2
    return 1
  fi

  rm -rf "$context_root"
  mkdir -p "$context_root"
  GIT_INDEX_FILE="$index_file" git -C "$REPO_ROOT" checkout-index \
    --all \
    --force \
    --prefix="${context_root}/"
  if ! GIT_INDEX_FILE="$index_file" git \
    -c core.fileMode=true \
    -C "$REPO_ROOT" \
    --work-tree="$context_root" \
    update-index \
    --refresh \
    --; then
    echo "materialized runner binary context cannot refresh its index" >&2
    return 1
  fi
  if ! GIT_INDEX_FILE="$index_file" git \
    -c core.fileMode=true \
    -C "$REPO_ROOT" \
    --work-tree="$context_root" \
    diff-files \
    --quiet \
    --; then
    echo "materialized runner binary context does not match its index" >&2
    GIT_INDEX_FILE="$index_file" git \
      -c core.fileMode=true \
      -C "$REPO_ROOT" \
      --work-tree="$context_root" \
      diff-files \
      --raw \
      --no-abbrev \
      -- >&2
    return 1
  fi

  emit "context-root" "$context_root"
  trap - EXIT
  cleanup_materialize
  materialize_temp_dir=""
}

build() {
  local actual_toolchain_image="${RUNNER_BINARY_ACTUAL_TOOLCHAIN_IMAGE:-}"
  if [ -z "$actual_toolchain_image" ]; then
    echo "missing required env: RUNNER_BINARY_ACTUAL_TOOLCHAIN_IMAGE" >&2
    exit 2
  fi
  if [ "$actual_toolchain_image" != "$RUNNER_BINARY_TOOLCHAIN_IMAGE" ]; then
    echo "runner binary toolchain mismatch: ${actual_toolchain_image} != ${RUNNER_BINARY_TOOLCHAIN_IMAGE}" >&2
    exit 2
  fi

  local metadata_path="${RUNNER_BINARY_METADATA_PATH:-${REPO_ROOT}/runner-binary-fresh/metadata.json}"
  if [[ "$metadata_path" != /* ]]; then
    metadata_path="${REPO_ROOT}/${metadata_path}"
  fi
  mkdir -p "$(dirname "$metadata_path")"

  local digest_output binary_input_digest
  digest_output=$(RUNNER_BINARY_GIT_REVISION="$source_sha" \
    GUEST_CLI_PATH="$cli_package" GUEST_CLI_MANIFEST_PATH="$cli_manifest" \
    "${SCRIPT_DIR}/digest.sh" "$target")
  binary_input_digest=$(sed -n 's/^binary-input-digest=//p' <<<"$digest_output")
  if [[ ! "$binary_input_digest" =~ ^[0-9a-f]{64}$ ]]; then
    echo "invalid runner binary input digest: ${binary_input_digest}" >&2
    exit 1
  fi

  materialize
  "${context_root}/.github/scripts/runner-binary-build/context.sh" \
    validate-workspace "$context_root"
  TARGET_TRIPLE="$target" \
  CARGO_TARGET_DIR="$cargo_target_dir" \
  RUNNER_BINARY_ACTUAL_TOOLCHAIN_IMAGE="$actual_toolchain_image" \
  RUNNER_BINARY_INPUT_DIGEST="$binary_input_digest" \
  RUNNER_BINARY_METADATA_PATH="$metadata_path" \
  GUEST_CLI_PATH="$cli_package" \
  GUEST_CLI_MANIFEST_PATH="$cli_manifest" \
  GUEST_CLI_SOURCE_SHA="$source_sha" \
    "${context_root}/.github/scripts/runner-binary-build/compile.sh"

  emit "binary-input-digest" "$binary_input_digest"
  emit "runner-path" "${cargo_target_dir}/${target}/${RUNNER_BINARY_PROFILE}/runner"
  emit "metadata-path" "$metadata_path"
}

case "${1:-build}" in
  materialize) materialize ;;
  build) build ;;
  *) echo "usage: build.sh [build|materialize]" >&2; exit 2 ;;
esac
