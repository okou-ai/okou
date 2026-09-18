#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="${SCRIPT_DIR}/runner-binary-cache.sh"
. "${SCRIPT_DIR}/runner-image-target.sh"
. "${SCRIPT_DIR}/runner-binary-download.sh"

fail() {
  echo "::error::Runner binary transport: $*" >&2
  exit 1
}

for name in REPO CURRENT_RUN_ID EXPECTED_TARGET EXPECTED_BINARY_INPUT_DIGEST \
  OUTPUT_DIR R2_ACCOUNT_ID R2_BUCKET_NAME AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  [ -n "${!name:-}" ] || fail "missing required env: ${name}"
done
[[ "$REPO" =~ ^[A-Za-z0-9_-][A-Za-z0-9_.-]*/[A-Za-z0-9_-][A-Za-z0-9_.-]*$ ]] || fail "invalid repository"
[[ "$CURRENT_RUN_ID" =~ ^[1-9][0-9]*$ ]] || fail "invalid run ID"
[[ "$EXPECTED_BINARY_INPUT_DIGEST" =~ ^[0-9a-f]{64}$ ]] || fail "invalid input digest"
runner_image_validate_target "$EXPECTED_TARGET"
if [ "$OUTPUT_DIR" = / ] || [ -e "$OUTPUT_DIR" ] || [ -L "$OUTPUT_DIR" ]; then
  fail "output directory already exists or is unsafe"
fi

# A consumer-only rerun keeps its successful producer from an earlier attempt.
# Bind the reference to this run and input, not the consumer's run_attempt.
# The input digest already includes the target; this prefix serves this repository.
reference_key="runner-binaries/transports/${CURRENT_RUN_ID}/${EXPECTED_BINARY_INPUT_DIGEST}.json"
mkdir -p "$(dirname "$OUTPUT_DIR")"
transport_tmp=$(mktemp -d "$(dirname "$OUTPUT_DIR")/runner-binary-transport.XXXXXX")
trap 'rm -rf "$transport_tmp"' EXIT

r2() {
  if ! timeout --kill-after=5s 120s aws s3api "$@" \
    --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
    --bucket "$R2_BUCKET_NAME" --cli-connect-timeout 5 --cli-read-timeout 30 \
    >"${transport_tmp}/aws.out" 2>"${transport_tmp}/aws.err"; then
    # AWS errors can contain signed request material; do not echo raw stderr.
    fail "R2 ${1} failed"
  fi
}

case "${1:-}" in
  publish)
    timeout --kill-after=5s 180s env \
      GITHUB_OUTPUT= OUTPUT_DIR="${transport_tmp}/published" \
      PRODUCER_REPOSITORY="$REPO" PRODUCER_RUN_ID="$CURRENT_RUN_ID" \
      "$CACHE" publish
    # Publish readiness only after the content-addressed binary is verified.
    # Repeated producers may replace this run's reference, never another run's.
    r2 put-object --key "$reference_key" \
      --body "${transport_tmp}/published/manifest.json" \
      --content-type application/json --cache-control 'private, no-store'
    mv "${transport_tmp}/published" "$OUTPUT_DIR"
    ;;
  download)
    mkdir "${transport_tmp}/download"
    manifest="${transport_tmp}/download/manifest.json"
    runner_binary_download fresh-manifest "$reference_key" bytes=0-65536 "$manifest" 120 240
    [ "$(stat -c '%s' "$manifest")" -le 65536 ] || fail "manifest exceeds 64 KiB"
    env GITHUB_OUTPUT= MANIFEST_PATH="$manifest" EXPECTED_REPOSITORY="$REPO" \
      "$CACHE" manifest-validate
    jq -e --argjson run_id "$CURRENT_RUN_ID" '.producer.runId == $run_id' \
      "$manifest" >/dev/null || fail "manifest belongs to a different run"

    compressed="${transport_tmp}/runner.zst"
    runner_binary_download fresh-binary "$(jq -r '.object.key' "$manifest")" \
      bytes=0-67108864 "$compressed" 120 240
    [ "$(stat -c '%s' "$compressed")" = "$(jq -r '.object.sizeBytes' "$manifest")" ] || \
      fail "compressed binary size mismatch"
    zstd -q -d -c "$compressed" | head -c 134217729 > "${transport_tmp}/download/runner"
    jq '{
      schemaVersion, binaryInputDigest, target, toolchainImage,
      guestSha256: .guests, runnerSha256: .runner.sha256, runnerSizeBytes: .runner.sizeBytes
    }' "$manifest" > "${transport_tmp}/download/metadata.json"
    env GITHUB_OUTPUT= FRESH_METADATA_PATH="${transport_tmp}/download/metadata.json" \
      RUNNER_PATH="${transport_tmp}/download/runner" "$CACHE" fresh-validate
    chmod 755 "${transport_tmp}/download/runner"
    mv "${transport_tmp}/download" "$OUTPUT_DIR"
    ;;
  *) fail "usage: runner-binary-transport.sh <publish|download>" ;;
esac
