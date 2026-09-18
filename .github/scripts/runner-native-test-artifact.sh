#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.github/scripts/runner-image-target.sh
source "$SCRIPT_DIR/runner-image-target.sh"
# shellcheck source=.github/scripts/runner-binary-download.sh
source "$SCRIPT_DIR/runner-binary-download.sh"

MAX_BINARY_BYTES=134217728
MAX_COMPRESSED_BYTES=67108864

fail() {
  echo "::error::Native test artifact: $*" >&2
  exit 1
}

for name in TARGET_TRIPLE TEST_NAME ARTIFACT_DIR GITHUB_REPOSITORY GITHUB_SHA \
  GITHUB_RUN_ID PRODUCER_ATTEMPT; do
  [ -n "${!name:-}" ] || fail "missing required env: $name"
done
runner_image_validate_target "$TARGET_TRIPLE"
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "invalid source SHA"
[[ "$GITHUB_RUN_ID" =~ ^[1-9][0-9]*$ && "$PRODUCER_ATTEMPT" =~ ^[1-9][0-9]*$ ]] || fail "invalid producer identity"
case "$TEST_NAME" in
  host_cpu_fairness) profile=release; profile_args=(--release) ;;
  guest_rpc) profile=ci; profile_args=(--profile ci) ;;
  *) fail "unsupported integration test: $TEST_NAME" ;;
esac

# This is an exact producer address, not a cross-run cache lookup. Using the
# producer's attempt also keeps consumer-only reruns on their original inputs.
object_prefix="runner-binaries/${TARGET_TRIPLE}/${GITHUB_RUN_ID}/${PRODUCER_ATTEMPT}/${TEST_NAME}"

validate_manifest() {
  local manifest=$1
  [[ -f "$manifest" && -s "$manifest" && ! -L "$manifest" ]] || fail "missing or invalid manifest"
  [ "$(stat -c '%s' "$manifest")" -le 65536 ] || fail "manifest exceeds 64 KiB"
  jq -e --arg repository "$GITHUB_REPOSITORY" --arg sha "$GITHUB_SHA" \
    --arg run "$GITHUB_RUN_ID" --arg attempt "$PRODUCER_ATTEMPT" \
    --arg target "$TARGET_TRIPLE" --arg test "$TEST_NAME" --arg profile "$profile" \
    --argjson max_size "$MAX_BINARY_BYTES" '
    .version == 1 and .repository == $repository and .sha == $sha
      and .run == $run and .attempt == $attempt and .target == $target
      and .test == $test and .profile == $profile
      and (.sha256 | type == "string" and test("^[0-9a-f]{64}$"))
      and (.sizeBytes | type == "number" and floor == . and . > 0 and . <= $max_size)
  ' "$manifest" >/dev/null || fail "producer identity or binary size mismatch"
}

validate_binary() {
  local binary=$1 manifest=$2 digest
  [[ -f "$binary" && -s "$binary" && ! -L "$binary" ]] || fail "missing or invalid test binary"
  [ "$(stat -c '%s' "$binary")" = "$(jq -r .sizeBytes "$manifest")" ] || fail "binary size mismatch"
  digest=$(sha256sum "$binary" | cut -d ' ' -f 1)
  [ "$digest" = "$(jq -r .sha256 "$manifest")" ] || fail "binary checksum mismatch"
}

prepare_r2() {
  for name in R2_ACCOUNT_ID R2_BUCKET_NAME AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
    [ -n "${!name:-}" ] || fail "missing required env: $name"
  done
  # The shared downloader uses this label in its safe diagnostics.
  EXPECTED_TARGET=$TARGET_TRIPLE
  R2_TEMP_ROOT=$(mktemp -d "$(dirname "$ARTIFACT_DIR")/native-test-r2.XXXXXX")
  trap 'rm -rf -- "$R2_TEMP_ROOT"' EXIT
}

r2_put() {
  local key=$1 body=$2 content_type=$3
  if ! AWS_MAX_ATTEMPTS=1 AWS_RETRY_MODE=standard AWS_CLI_ERROR_FORMAT=json \
    AWS_PAGER='' AWS_CLI_AUTO_PROMPT=off \
    timeout --kill-after=5s 120s aws s3api put-object \
      --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
      --bucket "$R2_BUCKET_NAME" --key "$key" --body "$body" \
      --content-type "$content_type" --cache-control 'private, no-store' \
      --cli-connect-timeout 5 --cli-read-timeout 30 \
      >"$R2_TEMP_ROOT/put.out" 2>"$R2_TEMP_ROOT/put.err"; then
    fail "R2 upload failed" # Provider diagnostics can contain signed request material.
  fi
}

case "${1:-}" in
  build)
    [[ ! -e "$ARTIFACT_DIR" && ! -L "$ARTIFACT_DIR" ]] || fail "artifact directory already exists"
    mkdir -p "$ARTIFACT_DIR"
    cargo_output=$(mktemp)
    trap 'rm -f "$cargo_output"' EXIT
    (
      cd "$SCRIPT_DIR/../../crates"
      cargo test --no-run "${profile_args[@]}" --target "$TARGET_TRIPLE" \
        -p sandbox-firecracker --test "$TEST_NAME" --message-format=json-render-diagnostics
    ) >"$cargo_output"
    test_bin=$(jq -ers --arg test "$TEST_NAME" '
      [.[] | select(.reason == "compiler-artifact" and .target.name == $test
        and .target.kind == ["test"] and .profile.test == true)
        | .executable | select(. != null)]
      | if length == 1 then .[0] else error("expected exactly one test executable") end
    ' "$cargo_output")
    [[ -s "$test_bin" && -x "$test_bin" ]] || fail "missing compiled executable"
    cp -- "$test_bin" "$ARTIFACT_DIR/test-bin"
    size=$(stat -c '%s' "$ARTIFACT_DIR/test-bin")
    [ "$size" -le "$MAX_BINARY_BYTES" ] || fail "compiled binary exceeds 128 MiB"
    digest=$(sha256sum "$ARTIFACT_DIR/test-bin" | cut -d ' ' -f 1)
    jq -n --arg repository "$GITHUB_REPOSITORY" --arg sha "$GITHUB_SHA" \
      --arg run "$GITHUB_RUN_ID" --arg attempt "$PRODUCER_ATTEMPT" \
      --arg target "$TARGET_TRIPLE" --arg test "$TEST_NAME" --arg profile "$profile" \
      --arg digest "$digest" --argjson size "$size" \
      '{version: 1, repository: $repository, sha: $sha, run: $run, attempt: $attempt,
        target: $target, test: $test, profile: $profile, sha256: $digest, sizeBytes: $size}' \
      >"$ARTIFACT_DIR/manifest.json"
    echo "producer-attempt=$PRODUCER_ATTEMPT" >>"${GITHUB_OUTPUT:?}"
    ;;
  publish)
    validate_manifest "$ARTIFACT_DIR/manifest.json"
    validate_binary "$ARTIFACT_DIR/test-bin" "$ARTIFACT_DIR/manifest.json"
    prepare_r2
    zstd -q -3 -T0 -c "$ARTIFACT_DIR/test-bin" >"$R2_TEMP_ROOT/test.zst"
    compressed_size=$(stat -c '%s' "$R2_TEMP_ROOT/test.zst")
    [ "$compressed_size" -le "$MAX_COMPRESSED_BYTES" ] || fail "compressed binary exceeds 64 MiB"
    jq --argjson size "$compressed_size" '. + {compressedSizeBytes: $size}' \
      "$ARTIFACT_DIR/manifest.json" >"$R2_TEMP_ROOT/manifest.json"
    r2_put "${object_prefix}.zst" "$R2_TEMP_ROOT/test.zst" application/zstd
    # A reference is ready only after its exact run/attempt payload was uploaded.
    r2_put "${object_prefix}.json" "$R2_TEMP_ROOT/manifest.json" application/json
    ;;
  download)
    [[ ! -e "$ARTIFACT_DIR" && ! -L "$ARTIFACT_DIR" ]] || fail "artifact directory already exists"
    prepare_r2
    mkdir "$R2_TEMP_ROOT/download"
    manifest="$R2_TEMP_ROOT/download/manifest.json"
    runner_binary_download native-test-manifest "${object_prefix}.json" bytes=0-65536 "$manifest" 120 240
    validate_manifest "$manifest"
    jq -e --argjson max_size "$MAX_COMPRESSED_BYTES" '
      .compressedSizeBytes | type == "number" and floor == . and . > 0 and . <= $max_size
    ' "$manifest" >/dev/null || fail "invalid compressed binary size"
    compressed="$R2_TEMP_ROOT/test.zst"
    runner_binary_download native-test-binary "${object_prefix}.zst" "bytes=0-${MAX_COMPRESSED_BYTES}" "$compressed" 120 240
    [ "$(stat -c '%s' "$compressed")" = "$(jq -r .compressedSizeBytes "$manifest")" ] || fail "compressed binary size mismatch"
    zstd -q -d -c "$compressed" | head -c "$((MAX_BINARY_BYTES + 1))" >"$R2_TEMP_ROOT/download/test-bin"
    validate_binary "$R2_TEMP_ROOT/download/test-bin" "$manifest"
    mv "$R2_TEMP_ROOT/download" "$ARTIFACT_DIR"
    ;;
  validate)
    validate_manifest "$ARTIFACT_DIR/manifest.json"
    validate_binary "$ARTIFACT_DIR/test-bin" "$ARTIFACT_DIR/manifest.json"
    chmod 755 "$ARTIFACT_DIR/test-bin"
    echo "TEST_BIN=$ARTIFACT_DIR/test-bin" >>"${GITHUB_ENV:?}"
    ;;
  *) fail "expected build, publish, download or validate" ;;
esac
