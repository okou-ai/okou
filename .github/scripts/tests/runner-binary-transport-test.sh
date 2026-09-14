#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRANSPORT="${SCRIPT_DIR}/runner-binary-transport.sh"
test_root=$(mktemp -d)
. "${SCRIPT_DIR}/tests/fixtures/runner-binary-r2.sh"
trap 'runner_binary_r2_fixture_stop; rm -rf "$test_root"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

mkdir -p "${test_root}/bin" "${test_root}/store"
runner_binary_r2_fixture_start "${test_root}" key

export PATH="${test_root}/bin:${PATH}"
export R2_STORE="${test_root}/store"
export AWS_ACCESS_KEY_ID=fixture-access AWS_SECRET_ACCESS_KEY=fixture-secret
export R2_ACCOUNT_ID=fixture-account R2_BUCKET_NAME=fixture-bucket
export REPO=vm0-ai/vm0 CURRENT_RUN_ID=100 PRODUCER_RUN_ATTEMPT=1
export PRODUCER_EVENT=pull_request PRODUCER_PR_NUMBER=123
export PRODUCER_HEAD_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
export EXPECTED_BINARY_INPUT_DIGEST=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

. "${SCRIPT_DIR}/runner-guest-binaries.sh"
. "${SCRIPT_DIR}/runner-binary-build/contract.env"
runner_guest_binaries_load
guests=$(printf '%s\n' "${RUNNER_GUEST_BINARIES[@]}" | jq -Rn \
  --arg sha "$EXPECTED_BINARY_INPUT_DIGEST" '[inputs | {key: ., value: $sha}] | from_entries')

make_fresh() {
  export EXPECTED_TARGET=$1
  export RUNNER_PATH="${test_root}/${EXPECTED_TARGET}-runner"
  export FRESH_METADATA_PATH="${test_root}/${EXPECTED_TARGET}-metadata.json"
  printf 'fresh runner for %s\n' "$EXPECTED_TARGET" > "$RUNNER_PATH"
  jq -n --arg target "$EXPECTED_TARGET" --arg digest "$EXPECTED_BINARY_INPUT_DIGEST" \
    --arg toolchain "$RUNNER_BINARY_TOOLCHAIN_IMAGE" --argjson guests "$guests" \
    --arg sha "$(sha256sum "$RUNNER_PATH" | cut -d' ' -f1)" \
    --argjson size "$(stat -c '%s' "$RUNNER_PATH")" '{
      schemaVersion: 1, target: $target, binaryInputDigest: $digest,
      toolchainImage: $toolchain, guestSha256: $guests,
      runnerSha256: $sha, runnerSizeBytes: $size
    }' > "$FRESH_METADATA_PATH"
}

expect_failure() {
  local output_dir=$1
  shift
  if OUTPUT_DIR="$output_dir" "$@" >"${test_root}/failure.log" 2>&1; then
    fail "expected transport failure for ${output_dir}"
  fi
  [ ! -e "$output_dir" ] || fail "failed transport exposed an output directory"
}

reference_path() {
  printf '%s/runner-binaries/transports/%s/%s/%s/%s.json\n' \
    "$R2_STORE" "$REPO" "$CURRENT_RUN_ID" "$EXPECTED_TARGET" "$EXPECTED_BINARY_INPUT_DIGEST"
}

for target in aarch64-unknown-linux-musl x86_64-unknown-linux-musl; do
  make_fresh "$target"
  OUTPUT_DIR="${test_root}/published-${target}" "$TRANSPORT" publish >/dev/null
  # A consumer-only rerun can read the successful attempt 1 producer.
  GITHUB_RUN_ATTEMPT=2 OUTPUT_DIR="${test_root}/download-${target}" "$TRANSPORT" download >/dev/null
  cmp "$RUNNER_PATH" "${test_root}/download-${target}/runner"
  [ -x "${test_root}/download-${target}/runner" ] || fail "download must be executable"
  jq -e '.producer.runAttempt == 1' "${test_root}/download-${target}/manifest.json" >/dev/null
  # Publishing again reuses and validates the content-addressed binary.
  PRODUCER_RUN_ATTEMPT=2 OUTPUT_DIR="${test_root}/republished-${target}" "$TRANSPORT" publish >/dev/null
  jq -e '.producer.runAttempt == 2' "$(reference_path)" >/dev/null
done

# Independent concurrent runs each retain their own ready reference.
CURRENT_RUN_ID=101 OUTPUT_DIR="${test_root}/run-101" "$TRANSPORT" publish >/dev/null &
first_pid=$!
CURRENT_RUN_ID=102 OUTPUT_DIR="${test_root}/run-102" "$TRANSPORT" publish >/dev/null &
second_pid=$!
wait "$first_pid"
wait "$second_pid"
for run_id in 101 102; do
  CURRENT_RUN_ID="$run_id" OUTPUT_DIR="${test_root}/read-${run_id}" "$TRANSPORT" download >/dev/null
  jq -e --argjson run "$run_id" '.producer.runId == $run' \
    "${test_root}/read-${run_id}/manifest.json" >/dev/null
done

for stage in binary manifest manifest-precondition; do
  CURRENT_RUN_ID=200 R2_TEST_MODE="$stage" expect_failure "${test_root}/failed-${stage}" "$TRANSPORT" publish
  if grep -q fixture-sensitive-query "${test_root}/failure.log"; then
    fail "transport leaked signed request material"
  fi
  [ ! -e "$(CURRENT_RUN_ID=200 reference_path)" ] || fail "failed publication advertised readiness"
done
AWS_ACCESS_KEY_ID='' expect_failure "${test_root}/missing-credentials" "$TRANSPORT" publish
AWS_SECRET_ACCESS_KEY=wrong expect_failure "${test_root}/invalid-signature" "$TRANSPORT" publish
CURRENT_RUN_ID=300 expect_failure "${test_root}/missing-reference" "$TRANSPORT" download
R2_TEST_MODE='get' expect_failure "${test_root}/get-failed" "$TRANSPORT" download
R2_TEST_MODE=redirect expect_failure "${test_root}/redirect" "$TRANSPORT" download
R2_TEST_MODE=disconnect expect_failure "${test_root}/interrupted-response" "$TRANSPORT" download

# Transient HTTP errors retry without duplicating a binary or exposing partial output.
CURRENT_RUN_ID=400 R2_TEST_MODE=retry-once OUTPUT_DIR="${test_root}/retried-publication" \
  "$TRANSPORT" publish >/dev/null
CURRENT_RUN_ID=400 R2_TEST_MODE=retry-once OUTPUT_DIR="${test_root}/retried-download" \
  "$TRANSPORT" download >/dev/null
cmp "$RUNNER_PATH" "${test_root}/retried-download/runner"

reference=$(reference_path)
cp "$reference" "${test_root}/valid-manifest.json"
for change in '.producer.runId = 999' '.producer.repository = "another/repo"' \
  '.target = "aarch64-unknown-linux-musl"' '.binaryInputDigest = "invalid"'; do
  jq "$change" "${test_root}/valid-manifest.json" > "$reference"
  expect_failure "${test_root}/wrong-identity" "$TRANSPORT" download
done
printf 'not json\n' > "$reference"
expect_failure "${test_root}/malformed-manifest" "$TRANSPORT" download
head -c 65537 /dev/zero > "$reference"
expect_failure "${test_root}/oversized-manifest" "$TRANSPORT" download
head -c 65538 /dev/zero > "$reference"
R2_TEST_MODE=ignore-range expect_failure "${test_root}/unbounded-manifest" "$TRANSPORT" download
cp "${test_root}/valid-manifest.json" "$reference"

object="${R2_STORE}/$(jq -r '.object.key' "$reference")"
mv "$object" "${test_root}/valid-binary.zst"
expect_failure "${test_root}/missing-binary" "$TRANSPORT" download
head -c 8 "${test_root}/valid-binary.zst" > "$object"
expect_failure "${test_root}/truncated-binary" "$TRANSPORT" download
# Keep the decoded size valid so this exercises the hash check, not just size.
head -c "$(stat -c '%s' "$RUNNER_PATH")" /dev/zero | zstd -q -c > "$object"
jq --argjson size "$(stat -c '%s' "$object")" '.object.sizeBytes = $size' \
  "${test_root}/valid-manifest.json" > "$reference"
expect_failure "${test_root}/hash-mismatch" "$TRANSPORT" download
cp "${test_root}/valid-binary.zst" "$object"
cp "${test_root}/valid-manifest.json" "$reference"

OUTPUT_DIR="${test_root}/recovered" "$TRANSPORT" download >/dev/null
cmp "$RUNNER_PATH" "${test_root}/recovered/runner"
if OUTPUT_DIR="${test_root}/recovered" "$TRANSPORT" download >/dev/null 2>&1; then
  fail "transport must not overwrite existing consumer output"
fi
cmp "$RUNNER_PATH" "${test_root}/recovered/runner"

echo "runner-binary-transport-test: ok"
