#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
. "${SCRIPT_DIR}/runner-image-target.sh"
. "${SCRIPT_DIR}/runner-guest-binaries.sh"
. "${REPO_ROOT}/.github/scripts/runner-binary-build/contract.env"

RUNNER_BINARY_MAX_SIZE_BYTES=$((128 * 1024 * 1024))
RUNNER_BINARY_MAX_COMPRESSED_BYTES=$((64 * 1024 * 1024))
RUNNER_BINARY_MAX_MANIFEST_ARTIFACT_BYTES=$((1024 * 1024))
RUNNER_BINARY_MAX_CANDIDATE_INSPECTIONS=8
RUNNER_BINARY_MAX_TRUSTED_IDENTITIES=2
RUNNER_BINARY_WORKFLOW_PATH=".github/workflows/runner-image.yml"

emit() {
  local key=$1 value=$2
  printf '%s=%s\n' "$key" "$value"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT"
  fi
}

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 2
  fi
}

guest_keys_json() {
  runner_guest_binaries_load
  printf '%s\n' "${RUNNER_GUEST_BINARIES[@]}" | jq -Rsc 'split("\n")[:-1] | sort'
}

load_fresh() {
  require_env FRESH_METADATA_PATH
  require_env RUNNER_PATH
  require_env EXPECTED_TARGET
  require_env EXPECTED_BINARY_INPUT_DIGEST

  local expected_target_input="${EXPECTED_TARGET:-}"
  local expected_digest_input="${EXPECTED_BINARY_INPUT_DIGEST:-}"
  runner_image_validate_target "$expected_target_input"
  if [[ ! "$expected_digest_input" =~ ^[0-9a-f]{64}$ ]]; then
    echo "invalid expected runner binary input digest: ${expected_digest_input}" >&2
    return 1
  fi
  if [ ! -f "$FRESH_METADATA_PATH" ] || [ -L "$FRESH_METADATA_PATH" ]; then
    echo "fresh runner metadata is not a regular file: ${FRESH_METADATA_PATH}" >&2
    return 1
  fi
  if [ ! -f "$RUNNER_PATH" ] || [ -L "$RUNNER_PATH" ]; then
    echo "fresh runner is not a regular file: ${RUNNER_PATH}" >&2
    return 1
  fi

  local expected_guests
  expected_guests=$(guest_keys_json)
  if ! jq -e \
    --arg digest "$expected_digest_input" \
    --arg target "$expected_target_input" \
    --arg toolchain "$RUNNER_BINARY_TOOLCHAIN_IMAGE" \
    --argjson guests "$expected_guests" \
    --argjson max_size "$RUNNER_BINARY_MAX_SIZE_BYTES" '
      (keys | sort) == [
        "binaryInputDigest", "guestSha256", "runnerSha256",
        "runnerSizeBytes", "schemaVersion", "target", "toolchainImage"
      ] and
      .schemaVersion == 1 and
      .binaryInputDigest == $digest and
      .target == $target and
      .toolchainImage == $toolchain and
      (.runnerSha256 | type == "string" and test("^[0-9a-f]{64}$")) and
      (.runnerSizeBytes | type == "number" and floor == . and . > 0 and . <= $max_size) and
      (.guestSha256 | type == "object") and
      ((.guestSha256 | keys | sort) == $guests) and
      all(.guestSha256[]; type == "string" and test("^[0-9a-f]{64}$"))
    ' "$FRESH_METADATA_PATH" >/dev/null; then
    echo "invalid fresh runner metadata: ${FRESH_METADATA_PATH}" >&2
    return 1
  fi

  FRESH_BINARY_INPUT_DIGEST=$(jq -r '.binaryInputDigest' "$FRESH_METADATA_PATH")
  FRESH_TARGET=$(jq -r '.target' "$FRESH_METADATA_PATH")
  FRESH_RUNNER_SHA=$(jq -r '.runnerSha256' "$FRESH_METADATA_PATH")
  FRESH_RUNNER_SIZE=$(jq -r '.runnerSizeBytes' "$FRESH_METADATA_PATH")
  FRESH_GUESTS=$(jq -cS '.guestSha256' "$FRESH_METADATA_PATH")

  local actual_size actual_sha
  actual_size=$(stat -c '%s' "$RUNNER_PATH")
  actual_sha=$(sha256sum "$RUNNER_PATH" | awk '{print $1}')
  if [ "$actual_size" != "$FRESH_RUNNER_SIZE" ]; then
    echo "fresh runner size mismatch: ${actual_size} != ${FRESH_RUNNER_SIZE}" >&2
    return 1
  fi
  if [ "$actual_sha" != "$FRESH_RUNNER_SHA" ]; then
    echo "fresh runner sha mismatch: ${actual_sha} != ${FRESH_RUNNER_SHA}" >&2
    return 1
  fi
}

fresh_validate() {
  load_fresh
  emit "binary-input-digest" "$FRESH_BINARY_INPUT_DIGEST"
  emit "runner-sha" "$FRESH_RUNNER_SHA"
  emit "runner-size-bytes" "$FRESH_RUNNER_SIZE"
  emit "guest-sha-json" "$FRESH_GUESTS"
}

validate_reusable_manifest() {
  require_env MANIFEST_PATH
  local manifest_path_input="${MANIFEST_PATH:-}"
  if [ ! -f "$manifest_path_input" ] || [ -L "$manifest_path_input" ]; then
    echo "reusable runner manifest is not a regular file: ${manifest_path_input}" >&2
    return 1
  fi

  local expected_guests expected_target expected_digest expected_repository expected_workflow
  expected_guests=$(guest_keys_json)
  expected_target="${EXPECTED_TARGET:-}"
  expected_digest="${EXPECTED_BINARY_INPUT_DIGEST:-}"
  expected_repository="${EXPECTED_REPOSITORY:-}"
  expected_workflow="${EXPECTED_WORKFLOW_PATH:-$RUNNER_BINARY_WORKFLOW_PATH}"

  if ! jq -e \
    --arg expected_target "$expected_target" \
    --arg expected_digest "$expected_digest" \
    --arg expected_toolchain "$RUNNER_BINARY_TOOLCHAIN_IMAGE" \
    --arg expected_repository "$expected_repository" \
    --arg expected_workflow "$expected_workflow" \
    --argjson guest_keys "$expected_guests" \
    --argjson max_runner_size "$RUNNER_BINARY_MAX_SIZE_BYTES" \
    --argjson max_compressed_size "$RUNNER_BINARY_MAX_COMPRESSED_BYTES" '
      (keys | sort) == [
        "binaryInputDigest", "createdAt", "guests", "object", "producer",
        "runner", "schemaVersion", "target", "toolchainImage"
      ] and
      .schemaVersion == 1 and
      (.binaryInputDigest | type == "string" and test("^[0-9a-f]{64}$")) and
      ($expected_digest == "" or .binaryInputDigest == $expected_digest) and
      (.target == "aarch64-unknown-linux-musl" or .target == "x86_64-unknown-linux-musl") and
      ($expected_target == "" or .target == $expected_target) and
      .toolchainImage == $expected_toolchain and
      (.runner | type == "object") and
      ((.runner | keys | sort) == ["sha256", "sizeBytes"]) and
      (.runner.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
      (.runner.sizeBytes | type == "number" and floor == . and . > 0 and . <= $max_runner_size) and
      (.guests | type == "object") and
      ((.guests | keys | sort) == $guest_keys) and
      all(.guests[]; type == "string" and test("^[0-9a-f]{64}$")) and
      (.object | type == "object") and
      ((.object | keys | sort) == ["compression", "key", "sizeBytes"]) and
      .object.compression == "zstd" and
      (.object.sizeBytes | type == "number" and floor == . and . > 0 and . <= $max_compressed_size) and
      .object.key == ("runner-binaries/" + .target + "/" + .runner.sha256 + ".zst") and
      (.producer | type == "object") and
      ((.producer | keys | sort) == [
        "event", "headSha", "prNumber", "repository", "runAttempt", "runId", "workflowPath"
      ]) and
      (.producer.repository | type == "string" and length > 0) and
      ($expected_repository == "" or .producer.repository == $expected_repository) and
      .producer.workflowPath == $expected_workflow and
      (.producer.runId | type == "number" and floor == . and . > 0) and
      (.producer.runAttempt | type == "number" and floor == . and . > 0) and
      (.producer.event == "push" or .producer.event == "pull_request" or .producer.event == "merge_group") and
      (.producer.headSha | type == "string" and test("^[0-9a-f]{40}$")) and
      (if .producer.event == "push" then
        .producer.prNumber == null
      else
        (.producer.prNumber | type == "number" and floor == . and . > 0)
      end) and
      (.createdAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
    ' "$manifest_path_input" >/dev/null; then
    echo "invalid reusable runner manifest: ${manifest_path_input}" >&2
    return 1
  fi

  REUSABLE_BINARY_INPUT_DIGEST=$(jq -r '.binaryInputDigest' "$manifest_path_input")
  REUSABLE_RUNNER_SHA=$(jq -r '.runner.sha256' "$manifest_path_input")
  REUSABLE_RUNNER_SIZE=$(jq -r '.runner.sizeBytes' "$manifest_path_input")
  REUSABLE_OBJECT_KEY=$(jq -r '.object.key' "$manifest_path_input")
  REUSABLE_OBJECT_SIZE=$(jq -r '.object.sizeBytes' "$manifest_path_input")
}

manifest_validate() {
  validate_reusable_manifest
  emit "binary-input-digest" "$REUSABLE_BINARY_INPUT_DIGEST"
  emit "runner-sha" "$REUSABLE_RUNNER_SHA"
  emit "runner-size-bytes" "$REUSABLE_RUNNER_SIZE"
  emit "object-key" "$REUSABLE_OBJECT_KEY"
  emit "object-size-bytes" "$REUSABLE_OBJECT_SIZE"
}

reusable_artifact_name() {
  local target=$1 digest=$2
  printf 'runner-binary-asset-%s-%s\n' "$target" "$digest"
}

artifact_name() {
  require_env EXPECTED_TARGET
  require_env EXPECTED_BINARY_INPUT_DIGEST
  runner_image_validate_target "$EXPECTED_TARGET"
  if [[ ! "$EXPECTED_BINARY_INPUT_DIGEST" =~ ^[0-9a-f]{64}$ ]]; then
    echo "invalid runner binary input digest: ${EXPECTED_BINARY_INPUT_DIGEST}" >&2
    exit 2
  fi
  emit "artifact-name" "$(reusable_artifact_name "$EXPECTED_TARGET" "$EXPECTED_BINARY_INPUT_DIGEST")"
}

publish_failure() {
  local reason=$1 message=$2
  echo "::error::Runner binary publication failed (${reason}): ${message}" >&2
  exit 1
}

fetch_verified_r2_runner() {
  local object_key=$1
  local expected_object_size=$2
  local expected_runner_size=$3
  local expected_runner_sha=$4
  local compressed_path=$5
  local runner_path=$6
  local endpoint head_json observed_object_size downloaded_size decompressed_size actual_sha
  local get_status=0 decompress_status=0
  local aws_error_log="${compressed_path}.aws.err"
  local zstd_error_log="${compressed_path}.zstd.err"

  R2_VERIFICATION_REASON=""
  R2_VERIFICATION_MESSAGE=""
  R2_VERIFIED_OBJECT_SIZE=""
  endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

  if ! head_json=$(aws s3api head-object \
    --endpoint-url "$endpoint" \
    --bucket "$R2_BUCKET_NAME" \
    --key "$object_key" \
    --output json \
    --cli-connect-timeout 5 \
    --cli-read-timeout 30 2>"$aws_error_log"); then
    R2_VERIFICATION_REASON="head-failed"
    R2_VERIFICATION_MESSAGE="the R2 object could not be inspected"
    return 1
  fi
  if ! observed_object_size=$(jq -er '.ContentLength | select(type == "number" and floor == .)' \
    <<<"$head_json" 2>/dev/null); then
    R2_VERIFICATION_REASON="head-malformed"
    R2_VERIFICATION_MESSAGE="the R2 object metadata was malformed"
    return 1
  fi
  if [[ ! "$observed_object_size" =~ ^[1-9][0-9]*$ ]] ||
    [ "$observed_object_size" -gt "$RUNNER_BINARY_MAX_COMPRESSED_BYTES" ]; then
    R2_VERIFICATION_REASON="size-mismatch"
    R2_VERIFICATION_MESSAGE="the R2 object is outside the configured bound"
    return 1
  fi
  if [ -n "$expected_object_size" ] && [ "$observed_object_size" != "$expected_object_size" ]; then
    R2_VERIFICATION_REASON="size-mismatch"
    R2_VERIFICATION_MESSAGE="the R2 object size does not match the reusable manifest"
    return 1
  fi

  aws s3api get-object \
    --endpoint-url "$endpoint" \
    --bucket "$R2_BUCKET_NAME" \
    --key "$object_key" \
    --range "bytes=0-${RUNNER_BINARY_MAX_COMPRESSED_BYTES}" \
    --cli-connect-timeout 5 \
    --cli-read-timeout 30 \
    "$compressed_path" \
    >/dev/null 2>"$aws_error_log" || get_status=$?
  if [ "$get_status" -ne 0 ]; then
    R2_VERIFICATION_REASON="get-failed"
    R2_VERIFICATION_MESSAGE="the R2 object could not be downloaded"
    return 1
  fi
  downloaded_size=$(stat -c '%s' "$compressed_path")
  if [ "$downloaded_size" != "$observed_object_size" ]; then
    R2_VERIFICATION_REASON="size-changed"
    R2_VERIFICATION_MESSAGE="the R2 object changed during validation"
    return 1
  fi

  zstd -q -d -c "$compressed_path" \
    2>"$zstd_error_log" \
    | head -c "$((RUNNER_BINARY_MAX_SIZE_BYTES + 1))" \
      > "$runner_path" || decompress_status=$?
  decompressed_size=$(stat -c '%s' "$runner_path")
  if [ "$decompress_status" -ne 0 ] ||
    [ "$decompressed_size" -gt "$RUNNER_BINARY_MAX_SIZE_BYTES" ]; then
    R2_VERIFICATION_REASON="decompression-invalid"
    R2_VERIFICATION_MESSAGE="the R2 object is not a bounded zstd runner"
    return 1
  fi
  actual_sha=$(sha256sum "$runner_path" | awk '{print $1}')
  if [ "$decompressed_size" != "$expected_runner_size" ] ||
    [ "$actual_sha" != "$expected_runner_sha" ]; then
    R2_VERIFICATION_REASON="content-mismatch"
    R2_VERIFICATION_MESSAGE="the R2 object does not match the expected runner identity"
    return 1
  fi

  R2_VERIFIED_OBJECT_SIZE="$observed_object_size"
}

validate_producer_inputs() {
  require_env PRODUCER_REPOSITORY
  require_env PRODUCER_RUN_ID
  require_env PRODUCER_RUN_ATTEMPT
  require_env PRODUCER_EVENT
  require_env PRODUCER_HEAD_SHA
  if [ "${PRODUCER_WORKFLOW_PATH:-$RUNNER_BINARY_WORKFLOW_PATH}" != "$RUNNER_BINARY_WORKFLOW_PATH" ]; then
    echo "unsupported producer workflow path: ${PRODUCER_WORKFLOW_PATH}" >&2
    return 1
  fi
  if [[ ! "$PRODUCER_RUN_ID" =~ ^[1-9][0-9]*$ ]] || [[ ! "$PRODUCER_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]; then
    echo "invalid producer run identity" >&2
    return 1
  fi
  if [[ ! "$PRODUCER_HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]; then
    echo "invalid producer head SHA" >&2
    return 1
  fi
  case "$PRODUCER_EVENT" in
    push)
      if [ -n "${PRODUCER_PR_NUMBER:-}" ]; then
        echo "push producer must not have a PR number" >&2
        return 1
      fi
      ;;
    pull_request|merge_group)
      if [[ ! "${PRODUCER_PR_NUMBER:-}" =~ ^[1-9][0-9]*$ ]]; then
        echo "${PRODUCER_EVENT} producer requires a PR number" >&2
        return 1
      fi
      ;;
    *) echo "unsupported producer event: ${PRODUCER_EVENT}" >&2; return 1 ;;
  esac
}

publish() {
  load_fresh
  validate_producer_inputs
  require_env OUTPUT_DIR
  if [ "${OUTPUT_DIR:?}" = "/" ]; then
    echo "refusing unsafe OUTPUT_DIR=/" >&2
    exit 2
  fi
  mkdir -p "$OUTPUT_DIR"

  if [ -z "${R2_ACCOUNT_ID:-}" ] || [ -z "${R2_BUCKET_NAME:-}" ] ||
    [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
    publish_failure "missing-r2-config" "required R2 configuration is unavailable"
  fi
  if ! command -v aws >/dev/null; then
    publish_failure "aws-unavailable" "AWS CLI is unavailable"
  fi
  if ! command -v zstd >/dev/null; then
    publish_failure "zstd-unavailable" "zstd is unavailable"
  fi

  local temp_root compressed retained decompressed error_log
  temp_root=$(mktemp -d "${RUNNER_TEMP:-${OUTPUT_DIR}}/runner-binary-publish.XXXXXX")
  compressed="${temp_root}/runner.zst"
  retained="${temp_root}/retained.zst"
  decompressed="${temp_root}/retained-runner"
  error_log="${temp_root}/aws.err"
  PUBLISH_TEMP_ROOT="$temp_root"
  trap 'rm -rf "$PUBLISH_TEMP_ROOT"' EXIT

  if ! zstd -q -3 -T0 -f -o "$compressed" "$RUNNER_PATH"; then
    publish_failure "compression-failed" "runner compression failed"
  fi
  local compressed_size
  compressed_size=$(stat -c '%s' "$compressed")
  if [ "$compressed_size" -le 0 ] || [ "$compressed_size" -gt "$RUNNER_BINARY_MAX_COMPRESSED_BYTES" ]; then
    publish_failure "compressed-size-invalid" "compressed runner is outside the configured bound"
  fi

  local object_key endpoint put_status
  object_key="runner-binaries/${FRESH_TARGET}/${FRESH_RUNNER_SHA}.zst"
  endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  put_status=0
  aws s3api put-object \
    --endpoint-url "$endpoint" \
    --bucket "$R2_BUCKET_NAME" \
    --key "$object_key" \
    --body "$compressed" \
    --content-type application/zstd \
    --cache-control 'private, max-age=259200' \
    --if-none-match '*' \
    --cli-connect-timeout 5 --cli-read-timeout 30 \
    >/dev/null 2>"$error_log" || put_status=$?
  if [ "$put_status" -ne 0 ] && ! grep -Eq 'PreconditionFailed|precondition|412' "$error_log"; then
    publish_failure "put-failed" "R2 rejected the runner object upload"
  fi

  local retained_size publish_reason
  if ! fetch_verified_r2_runner \
    "$object_key" "" "$FRESH_RUNNER_SIZE" "$FRESH_RUNNER_SHA" \
    "$retained" "$decompressed"; then
    case "$R2_VERIFICATION_REASON" in
      size-mismatch) publish_reason="retained-size-invalid" ;;
      size-changed) publish_reason="retained-size-changed" ;;
      content-mismatch) publish_reason="retained-content-mismatch" ;;
      *) publish_reason="$R2_VERIFICATION_REASON" ;;
    esac
    publish_failure "$publish_reason" "$R2_VERIFICATION_MESSAGE"
  fi
  retained_size="$R2_VERIFIED_OBJECT_SIZE"

  local pr_number_json created_at manifest_tmp
  if [ -n "${PRODUCER_PR_NUMBER:-}" ]; then
    pr_number_json="$PRODUCER_PR_NUMBER"
  else
    pr_number_json="null"
  fi
  created_at=$(date -u +%FT%TZ)
  manifest_tmp="${OUTPUT_DIR}/manifest.json.tmp"
  jq -n \
    --arg binary_input_digest "$FRESH_BINARY_INPUT_DIGEST" \
    --arg target "$FRESH_TARGET" \
    --arg toolchain "$RUNNER_BINARY_TOOLCHAIN_IMAGE" \
    --arg runner_sha "$FRESH_RUNNER_SHA" \
    --argjson runner_size "$FRESH_RUNNER_SIZE" \
    --argjson guests "$FRESH_GUESTS" \
    --arg key "$object_key" \
    --argjson object_size "$retained_size" \
    --arg repository "$PRODUCER_REPOSITORY" \
    --arg workflow_path "${PRODUCER_WORKFLOW_PATH:-$RUNNER_BINARY_WORKFLOW_PATH}" \
    --argjson run_id "$PRODUCER_RUN_ID" \
    --argjson run_attempt "$PRODUCER_RUN_ATTEMPT" \
    --arg event "$PRODUCER_EVENT" \
    --arg head_sha "$PRODUCER_HEAD_SHA" \
    --argjson pr_number "$pr_number_json" \
    --arg created_at "$created_at" '
      {
        schemaVersion: 1,
        binaryInputDigest: $binary_input_digest,
        target: $target,
        toolchainImage: $toolchain,
        runner: {sha256: $runner_sha, sizeBytes: $runner_size},
        guests: $guests,
        object: {key: $key, compression: "zstd", sizeBytes: $object_size},
        producer: {
          repository: $repository,
          workflowPath: $workflow_path,
          runId: $run_id,
          runAttempt: $run_attempt,
          event: $event,
          headSha: $head_sha,
          prNumber: $pr_number
        },
        createdAt: $created_at
      }
    ' > "$manifest_tmp"
  mv -f "$manifest_tmp" "${OUTPUT_DIR}/manifest.json"

  env GITHUB_OUTPUT= \
    MANIFEST_PATH="${OUTPUT_DIR}/manifest.json" \
    EXPECTED_TARGET="$FRESH_TARGET" \
    EXPECTED_BINARY_INPUT_DIGEST="$FRESH_BINARY_INPUT_DIGEST" \
    EXPECTED_REPOSITORY="$PRODUCER_REPOSITORY" \
    EXPECTED_WORKFLOW_PATH="${PRODUCER_WORKFLOW_PATH:-$RUNNER_BINARY_WORKFLOW_PATH}" \
    "$0" manifest-validate >/dev/null

  emit "published" "true"
  emit "publish-reason" "$([ "$put_status" -eq 0 ] && echo uploaded || echo existing-validated)"
  emit "manifest-path" "${OUTPUT_DIR}/manifest.json"
  emit "object-key" "$object_key"
  emit "object-size-bytes" "$retained_size"
}

shadow_result() {
  local outcome=$1 source=$2 reason=$3 run_id=${4:-}
  emit "shadow-outcome" "$outcome"
  emit "shadow-source" "$source"
  emit "shadow-reason" "$reason"
  emit "shadow-producer-run-id" "$run_id"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### Runner binary shadow"
      echo
      echo "- Outcome: \`${outcome}\`"
      echo "- Source: \`${source:-none}\`"
      echo "- Reason: \`${reason}\`"
      if [ -n "$run_id" ]; then
        echo "- Producer run: \`${run_id}\`"
      fi
    } >> "$GITHUB_STEP_SUMMARY"
  fi
}

validate_resolution_context() {
  require_env REPO
  require_env CURRENT_RUN_ID
  require_env CURRENT_EVENT
  require_env DEFAULT_BRANCH
  case "$CURRENT_EVENT" in
    pull_request|merge_group)
      if [[ ! "${CURRENT_PR_NUMBER:-}" =~ ^[1-9][0-9]*$ ]]; then
        echo "${CURRENT_EVENT} runner binary resolution requires a current PR number" >&2
        exit 2
      fi
      ;;
    push) ;;
    *) echo "unsupported current event: ${CURRENT_EVENT}" >&2; exit 2 ;;
  esac
}

producer_is_main_reachable() {
  local producer_head_sha=$1 comparison_json
  if ! comparison_json=$(gh api \
    "repos/${REPO}/compare/${producer_head_sha}...${DEFAULT_BRANCH}" 2>/dev/null); then
    return 1
  fi
  jq -e \
    --arg producer_head_sha "$producer_head_sha" '
      (.base_commit | type == "object") and
      .base_commit.sha == $producer_head_sha and
      (.merge_base_commit | type == "object") and
      .merge_base_commit.sha == $producer_head_sha and
      (.ahead_by | type == "number" and floor == . and . >= 0) and
      (.behind_by | type == "number" and floor == . and . >= 0) and
      (
        (
          .status == "identical" and
          .ahead_by == 0 and
          .behind_by == 0
        ) or
        (
          .status == "ahead" and
          .ahead_by > 0 and
          .behind_by == 0
        )
      )
    ' <<<"$comparison_json" >/dev/null
}

collect_trusted_candidates() {
  local expected_target=$1 expected_digest=$2 output_dir=$3
  mkdir -p "$output_dir"

  local artifact_name_value artifacts_json
  artifact_name_value=$(reusable_artifact_name "$expected_target" "$expected_digest")
  if ! artifacts_json=$(gh api --paginate --slurp \
    "repos/${REPO}/actions/artifacts?name=${artifact_name_value}&per_page=100" 2>/dev/null); then
    CANDIDATE_DISCOVERY_REASON="artifact-api-unavailable"
    return 1
  fi
  if ! jq -e 'type == "array" and all(.[]; type == "object" and (.artifacts | type == "array"))' \
    <<<"$artifacts_json" >/dev/null; then
    CANDIDATE_DISCOVERY_REASON="artifact-api-malformed"
    return 1
  fi

  local potential_file sorted_potential trusted_unsorted trusted_file identities_file
  potential_file="${output_dir}/potential-candidates.tsv"
  sorted_potential="${output_dir}/potential-candidates-sorted.tsv"
  trusted_unsorted="${output_dir}/trusted-candidates-unsorted.tsv"
  trusted_file="${output_dir}/trusted-candidates.tsv"
  identities_file="${output_dir}/trusted-identities.tsv"
  : > "$potential_file"
  : > "$trusted_unsorted"
  : > "$trusted_file"
  : > "$identities_file"
  while IFS= read -r artifact_encoded; do
    [ -n "$artifact_encoded" ] || continue
    local artifact_json artifact_run_id artifact_id artifact_size artifact_created artifact_branch artifact_head_sha
    artifact_json=$(base64 -d <<<"$artifact_encoded")
    artifact_run_id=$(jq -r '.workflow_run.id // empty' <<<"$artifact_json")
    artifact_id=$(jq -r '.id // empty' <<<"$artifact_json")
    artifact_size=$(jq -r '.size_in_bytes // empty' <<<"$artifact_json")
    artifact_created=$(jq -r '.created_at // empty' <<<"$artifact_json")
    artifact_branch=$(jq -r '.workflow_run.head_branch // empty' <<<"$artifact_json")
    artifact_head_sha=$(jq -r '.workflow_run.head_sha // empty' <<<"$artifact_json")
    if [[ ! "$artifact_run_id" =~ ^[1-9][0-9]*$ ]] ||
      [[ ! "$artifact_id" =~ ^[1-9][0-9]*$ ]] ||
      [[ ! "$artifact_size" =~ ^[1-9][0-9]*$ ]] ||
      [ "$artifact_size" -gt "$RUNNER_BINARY_MAX_MANIFEST_ARTIFACT_BYTES" ] ||
      [[ ! "$artifact_head_sha" =~ ^[0-9a-f]{40}$ ]] ||
      [ "$artifact_run_id" = "$CURRENT_RUN_ID" ]; then
      continue
    fi

    local discovery_rank="" discovery_source_rank=""
    if [ "$artifact_branch" = "$DEFAULT_BRANCH" ]; then
      discovery_rank=0
      case "$CURRENT_EVENT" in
        pull_request|push) discovery_source_rank=0 ;;
        merge_group) discovery_source_rank=1 ;;
      esac
    elif [ -n "${CURRENT_PR_HEAD_REF:-}" ] && [ "$artifact_branch" = "$CURRENT_PR_HEAD_REF" ]; then
      discovery_rank=0
      case "$CURRENT_EVENT" in
        pull_request) discovery_source_rank=2 ;;
        merge_group) discovery_source_rank=0 ;;
        push) continue ;;
      esac
    elif [ -n "${CURRENT_PR_NUMBER:-}" ] && [[ "$artifact_branch" =~ (^|/)pr-${CURRENT_PR_NUMBER}- ]]; then
      discovery_rank=0
      case "$CURRENT_EVENT" in
        pull_request) discovery_source_rank=2 ;;
        merge_group) discovery_source_rank=0 ;;
        push) continue ;;
      esac
    else
      discovery_rank=1
      case "$CURRENT_EVENT" in
        pull_request) discovery_source_rank=1 ;;
        merge_group) discovery_source_rank=2 ;;
        push) discovery_source_rank=1 ;;
      esac
    fi

    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$discovery_rank" "$discovery_source_rank" "$artifact_created" \
      "$artifact_id" "$artifact_run_id" "$artifact_head_sha" >> "$potential_file"
  done < <(jq -r \
    --arg name "$artifact_name_value" '
      .[] | .artifacts[]? |
      select(.name == $name and .expired == false) |
      @base64
    ' <<<"$artifacts_json")

  # Inspect direct source hints before candidates that need an ancestry query.
  sort -t $'\t' -k1,1n -k2,2n -k3,3r "$potential_file" > "$sorted_potential"

  local inspected=0 trusted_count=0 identity_count=0 limit_reached=false
  local potential_count
  potential_count=$(wc -l < "$sorted_potential" | tr -d ' ')
  while IFS=$'\t' read -r _ _ artifact_created artifact_id artifact_run_id artifact_head_sha; do
    [ -n "$artifact_run_id" ] || continue
    if [ "$inspected" -ge "$RUNNER_BINARY_MAX_CANDIDATE_INSPECTIONS" ]; then
      break
    fi
    inspected=$((inspected + 1))

    local run_json
    if ! run_json=$(gh api "repos/${REPO}/actions/runs/${artifact_run_id}" 2>/dev/null); then
      continue
    fi
    if ! jq -e \
      --arg repo "$REPO" \
      --arg workflow "$RUNNER_BINARY_WORKFLOW_PATH" \
      --argjson run_id "$artifact_run_id" \
      --arg artifact_head_sha "$artifact_head_sha" '
        .id == $run_id and
        .repository.full_name == $repo and
        .path == $workflow and
        .status == "completed" and
        .head_sha == $artifact_head_sha and
        (.run_attempt | type == "number" and . > 0)
      ' <<<"$run_json" >/dev/null; then
      continue
    fi

    local actual_source="" run_event run_branch producer_pr_numbers
    run_event=$(jq -r '.event' <<<"$run_json")
    run_branch=$(jq -r '.head_branch' <<<"$run_json")
    case "$run_event" in
      push)
        producer_pr_numbers='[]'
        if [ "$run_branch" = "$DEFAULT_BRANCH" ]; then
          actual_source="protected-main"
        fi
        ;;
      pull_request)
        if ! producer_pr_numbers=$(jq -ce '
          [.pull_requests[]?.number] |
          select(
            length > 0 and
            all(.[]; type == "number" and floor == . and . > 0)
          )
        ' <<<"$run_json"); then
          continue
        fi
        if [ -n "${CURRENT_PR_NUMBER:-}" ] &&
          jq -e --argjson pr "$CURRENT_PR_NUMBER" 'index($pr) != null' \
            <<<"$producer_pr_numbers" >/dev/null; then
          actual_source="same-pr"
        fi
        ;;
      merge_group)
        if [[ ! "$run_branch" =~ (^|/)pr-([1-9][0-9]*)- ]]; then
          continue
        fi
        producer_pr_numbers="[${BASH_REMATCH[2]}]"
        if [ -n "${CURRENT_PR_NUMBER:-}" ] &&
          [ "${BASH_REMATCH[2]}" = "$CURRENT_PR_NUMBER" ]; then
          actual_source="same-pr"
        fi
        ;;
      *) continue ;;
    esac
    if [ -z "$actual_source" ]; then
      if producer_is_main_reachable "$artifact_head_sha"; then
        actual_source="main-reachable"
      else
        continue
      fi
    fi
    local source_rank
    case "${CURRENT_EVENT}:${actual_source}" in
      pull_request:protected-main) source_rank=0 ;;
      pull_request:main-reachable) source_rank=1 ;;
      pull_request:same-pr) source_rank=2 ;;
      merge_group:same-pr) source_rank=0 ;;
      merge_group:protected-main) source_rank=1 ;;
      merge_group:main-reachable) source_rank=2 ;;
      push:protected-main) source_rank=0 ;;
      push:main-reachable) source_rank=1 ;;
      *) continue ;;
    esac

    local candidate_dir manifest_path
    candidate_dir="${output_dir}/candidate-${artifact_id}"
    rm -rf "$candidate_dir"
    mkdir -p "$candidate_dir"
    if ! gh run download "$artifact_run_id" -n "$artifact_name_value" -D "$candidate_dir" \
      >/dev/null 2>&1; then
      continue
    fi
    mapfile -t manifest_candidates < <(find "$candidate_dir" -type f -name manifest.json | sort)
    if [ "${#manifest_candidates[@]}" -ne 1 ]; then
      continue
    fi
    manifest_path="${manifest_candidates[0]}"
    if ! env GITHUB_OUTPUT= \
      MANIFEST_PATH="$manifest_path" \
      EXPECTED_TARGET="$expected_target" \
      EXPECTED_BINARY_INPUT_DIGEST="$expected_digest" \
      EXPECTED_REPOSITORY="$REPO" \
      EXPECTED_WORKFLOW_PATH="$RUNNER_BINARY_WORKFLOW_PATH" \
        "$0" manifest-validate >/dev/null 2>&1; then
      continue
    fi

    local run_attempt current_pr_json
    run_attempt=$(jq -r '.run_attempt' <<<"$run_json")
    current_pr_json="${CURRENT_PR_NUMBER:-null}"
    if ! jq -e \
      --argjson run_id "$artifact_run_id" \
      --argjson run_attempt "$run_attempt" \
      --arg event "$run_event" \
      --arg head_sha "$artifact_head_sha" \
      --arg source "$actual_source" \
      --argjson producer_pr_numbers "$producer_pr_numbers" \
      --argjson current_pr_number "$current_pr_json" '
        .producer.runId == $run_id and
        .producer.runAttempt == $run_attempt and
        .producer.event == $event and
        .producer.headSha == $head_sha and
        (
          if $event == "push" then
            .producer.prNumber == null
          else
            .producer.prNumber as $producer_pr_number |
            ($producer_pr_numbers | index($producer_pr_number)) != null
          end
        ) and
        (
          if $source == "same-pr" then
            .producer.prNumber == $current_pr_number
          else
            true
          end
        )
      ' "$manifest_path" >/dev/null; then
      continue
    fi

    local identity identity_key
    identity=$(jq -cS '{runner, guests}' "$manifest_path")
    identity_key=$(sha256sum <<<"$identity" | awk '{print $1}')
    if ! grep -qxF "$identity_key" "$identities_file"; then
      printf '%s\n' "$identity_key" >> "$identities_file"
      identity_count=$((identity_count + 1))
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$source_rank" "$artifact_created" "$artifact_id" "$artifact_run_id" \
      "$actual_source" "$manifest_path" >> "$trusted_unsorted"
    trusted_count=$((trusted_count + 1))
    if [ "$identity_count" -ge "$RUNNER_BINARY_MAX_TRUSTED_IDENTITIES" ]; then
      break
    fi
  done < "$sorted_potential"

  # Select by the source proven from canonical run metadata, not the hint.
  sort -t $'\t' -k1,1n -k2,2r "$trusted_unsorted" > "$trusted_file"

  if [ "$inspected" -ge "$RUNNER_BINARY_MAX_CANDIDATE_INSPECTIONS" ] &&
    [ "$potential_count" -gt "$inspected" ]; then
    limit_reached=true
  fi

  TRUSTED_CANDIDATES_FILE="$trusted_file"
  TRUSTED_CANDIDATE_COUNT="$trusted_count"
  TRUSTED_IDENTITY_COUNT="$identity_count"
  if [ "$trusted_count" -eq 0 ]; then
    if [ "$limit_reached" = "true" ]; then
      CANDIDATE_DISCOVERY_REASON="candidate-limit-exhausted"
    else
      CANDIDATE_DISCOVERY_REASON="no-trusted-candidate"
    fi
  elif [ "$identity_count" -gt 1 ]; then
    CANDIDATE_DISCOVERY_REASON="trusted-output-conflict"
  else
    CANDIDATE_DISCOVERY_REASON="trusted-candidate"
  fi
}

first_trusted_candidate() {
  IFS=$'\t' read -r _ _ _ \
    TRUSTED_RUN_ID TRUSTED_SOURCE TRUSTED_MANIFEST_PATH < "$TRUSTED_CANDIDATES_FILE"
  [ -n "${TRUSTED_RUN_ID:-}" ]
}

shadow_resolve() {
  load_fresh
  require_env SHADOW_OUTPUT_DIR
  if [ "$SHADOW_OUTPUT_DIR" = "/" ]; then
    echo "refusing unsafe SHADOW_OUTPUT_DIR=/" >&2
    exit 2
  fi
  mkdir -p "$SHADOW_OUTPUT_DIR"
  validate_resolution_context

  if ! collect_trusted_candidates \
    "$FRESH_TARGET" "$FRESH_BINARY_INPUT_DIGEST" "$SHADOW_OUTPUT_DIR"; then
    shadow_result "error" "" "$CANDIDATE_DISCOVERY_REASON"
    return 0
  fi
  if [ "$TRUSTED_IDENTITY_COUNT" -gt 1 ]; then
    first_trusted_candidate
    shadow_result "conflict" "$TRUSTED_SOURCE" \
      "equal-input-output-mismatch" "$TRUSTED_RUN_ID"
    echo "equal runner binary input digest produced conflicting output identity: current run ${CURRENT_RUN_ID}, candidate run ${TRUSTED_RUN_ID}" >&2
    return 1
  fi
  if [ "$TRUSTED_CANDIDATE_COUNT" -eq 0 ]; then
    shadow_result "miss" "" "$CANDIDATE_DISCOVERY_REASON"
    return 0
  fi

  first_trusted_candidate
  local candidate_runner_sha candidate_runner_size candidate_guests
  candidate_runner_sha=$(jq -r '.runner.sha256' "$TRUSTED_MANIFEST_PATH")
  candidate_runner_size=$(jq -r '.runner.sizeBytes' "$TRUSTED_MANIFEST_PATH")
  candidate_guests=$(jq -cS '.guests' "$TRUSTED_MANIFEST_PATH")
  if [ "$candidate_runner_sha" != "$FRESH_RUNNER_SHA" ] ||
    [ "$candidate_runner_size" != "$FRESH_RUNNER_SIZE" ] ||
    [ "$candidate_guests" != "$FRESH_GUESTS" ]; then
    shadow_result "conflict" "$TRUSTED_SOURCE" \
      "equal-input-output-mismatch" "$TRUSTED_RUN_ID"
    echo "equal runner binary input digest produced conflicting output identity: current run ${CURRENT_RUN_ID}, candidate run ${TRUSTED_RUN_ID}" >&2
    return 1
  fi

  shadow_result "hit" "$TRUSTED_SOURCE" "equal-output" "$TRUSTED_RUN_ID"
}

resolve_result() {
  local outcome=$1 source=$2 reason=$3 run_id=${4:-}
  emit "resolve-outcome" "$outcome"
  emit "resolve-source" "$source"
  emit "resolve-reason" "$reason"
  emit "resolve-producer-run-id" "$run_id"
}

validate_cache_request() {
  require_env EXPECTED_TARGET
  require_env EXPECTED_BINARY_INPUT_DIGEST
  require_env RESOLVE_OUTPUT_DIR
  runner_image_validate_target "$EXPECTED_TARGET"
  if [[ ! "$EXPECTED_BINARY_INPUT_DIGEST" =~ ^[0-9a-f]{64}$ ]]; then
    echo "invalid expected runner binary input digest: ${EXPECTED_BINARY_INPUT_DIGEST}" >&2
    exit 2
  fi
  if [ "$RESOLVE_OUTPUT_DIR" = "/" ] || [ -e "$RESOLVE_OUTPUT_DIR" ] || [ -L "$RESOLVE_OUTPUT_DIR" ]; then
    echo "runner binary resolve output already exists or is unsafe: ${RESOLVE_OUTPUT_DIR}" >&2
    exit 2
  fi
}

r2_available() {
  [ -n "${R2_ACCOUNT_ID:-}" ] && [ -n "${R2_BUCKET_NAME:-}" ] &&
    [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] &&
    command -v aws >/dev/null
}

cache_temp_directory() {
  local output_parent
  output_parent=$(dirname "$RESOLVE_OUTPUT_DIR")
  mkdir -p "$output_parent"
  RUNNER_CACHE_TEMP_ROOT=$(mktemp -d "${RUNNER_TEMP:-$output_parent}/runner-binary-cache.XXXXXX")
  trap 'rm -rf "$RUNNER_CACHE_TEMP_ROOT"' EXIT
}

validate_cache_reference() {
  jq -e \
    --arg target "$EXPECTED_TARGET" \
    --arg digest "$EXPECTED_BINARY_INPUT_DIGEST" \
    --arg toolchain "$RUNNER_BINARY_TOOLCHAIN_IMAGE" \
    --argjson guests "$(guest_keys_json)" '
      .schemaVersion == 1 and
      .target == $target and
      .binaryInputDigest == $digest and
      .toolchainImage == $toolchain and
      (.objectKey | type == "string" and
        test("^runner-binaries/" + $target + "/[0-9a-f]{64}\\.zst$")) and
      (.guestSha256 | type == "object") and
      ((.guestSha256 | keys | sort) == $guests) and
      all(.guestSha256[]; type == "string" and test("^[0-9a-f]{64}$"))
    ' <<<"$CACHE_REFERENCE" >/dev/null
}

resolve_reference() {
  validate_cache_request
  require_env REPO
  case "${RUNNER_BINARY_CACHE_FORCE_MISS:-false}" in
    true)
      resolve_result "miss" "" "force-miss"
      return 0
      ;;
    false|"") ;;
    *) echo "invalid RUNNER_BINARY_CACHE_FORCE_MISS" >&2; exit 2 ;;
  esac
  if ! r2_available; then
    resolve_result "miss" "" "missing-r2-config"
    return 0
  fi

  local name artifacts candidates run_id artifact_id inspected=0 reason=no-candidate
  name=$(reusable_artifact_name "$EXPECTED_TARGET" "$EXPECTED_BINARY_INPUT_DIGEST")
  if ! artifacts=$(gh api --paginate --slurp \
    "repos/${REPO}/actions/artifacts?name=${name}&per_page=100" 2>/dev/null); then
    resolve_result "miss" "" "artifact-api-unavailable"
    return 0
  fi
  if ! candidates=$(jq -ce --arg name "$name" \
    --argjson max_size "$RUNNER_BINARY_MAX_MANIFEST_ARTIFACT_BYTES" \
    --argjson limit "$RUNNER_BINARY_MAX_CANDIDATE_INSPECTIONS" '
      [ .[] | .artifacts[] |
        select(.name == $name and .expired == false) |
        select(.size_in_bytes > 0 and .size_in_bytes <= $max_size) |
        select(.id | type == "number" and . > 0) |
        select(.workflow_run.id | type == "number" and . > 0)
      ] | sort_by(.created_at) | reverse | .[:$limit]
    ' <<<"$artifacts" 2>/dev/null); then
    resolve_result "miss" "" "artifact-api-malformed"
    return 0
  fi

  cache_temp_directory
  while IFS=$'\t' read -r run_id artifact_id; do
    [ -n "$run_id" ] || continue
    inspected=$((inspected + 1))
    local candidate_dir="${RUNNER_CACHE_TEMP_ROOT}/${artifact_id}"
    mkdir -p "$candidate_dir"
    # GitHub is only the existing cache index; R2 does not need run/ancestry proof.
    if ! gh run download "$run_id" -n "$name" -D "$candidate_dir" >/dev/null 2>&1; then
      continue
    fi
    if ! CACHE_REFERENCE=$(jq -c '{
      schemaVersion, binaryInputDigest, target, toolchainImage,
      objectKey: .object.key, guestSha256: .guests
    }' "${candidate_dir}/manifest.json" 2>/dev/null) ||
      ! validate_cache_reference 2>/dev/null; then
      continue
    fi
    local object_key
    object_key=$(jq -r '.objectKey' <<<"$CACHE_REFERENCE")
    if ! aws s3api head-object \
      --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
      --bucket "$R2_BUCKET_NAME" --key "$object_key" \
      --cli-connect-timeout 5 --cli-read-timeout 30 >/dev/null 2>&1; then
      reason=r2-unavailable
      continue
    fi
    mkdir -p "$RESOLVE_OUTPUT_DIR"
    printf '%s\n' "$CACHE_REFERENCE" > "${RESOLVE_OUTPUT_DIR}/reference.json"
    emit "candidate-inspections" "$inspected"
    resolve_result "hit" "r2" "reference" "$run_id"
    return 0
  done < <(jq -r '.[] | [.workflow_run.id, .id] | @tsv' <<<"$candidates")
  emit "candidate-inspections" "$inspected"
  resolve_result "miss" "" "$reason"
}

download_reference() {
  validate_cache_request
  require_env CACHE_REFERENCE
  require_env R2_ACCOUNT_ID
  require_env R2_BUCKET_NAME
  require_env AWS_ACCESS_KEY_ID
  require_env AWS_SECRET_ACCESS_KEY
  if ! validate_cache_reference; then
    echo "invalid cached runner reference" >&2
    exit 2
  fi
  cache_temp_directory
  local object_key compressed runner transport runner_size runner_sha
  object_key=$(jq -r '.objectKey' <<<"$CACHE_REFERENCE")
  compressed="${RUNNER_CACHE_TEMP_ROOT}/runner.zst"
  transport="${RUNNER_CACHE_TEMP_ROOT}/transport"
  mkdir -p "$transport"
  runner="${transport}/runner"
  timeout --kill-after=5s 60s aws s3api get-object \
    --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
    --bucket "$R2_BUCKET_NAME" --key "$object_key" \
    --range "bytes=0-${RUNNER_BINARY_MAX_COMPRESSED_BYTES}" \
    --cli-connect-timeout 5 --cli-read-timeout 30 \
    "$compressed" >/dev/null
  zstd -q -d -c "$compressed" |
    head -c "$((RUNNER_BINARY_MAX_SIZE_BYTES + 1))" > "$runner"
  runner_size=$(stat -c '%s' "$runner")
  if [ "$runner_size" -eq 0 ] || [ "$runner_size" -gt "$RUNNER_BINARY_MAX_SIZE_BYTES" ]; then
    echo "cached runner size is invalid: ${runner_size}" >&2
    exit 1
  fi
  # Record local transport identity, without comparing trusted R2 bytes to GitHub.
  runner_sha=$(sha256sum "$runner" | awk '{print $1}')
  jq --arg sha "$runner_sha" --argjson size "$runner_size" '{
    schemaVersion, binaryInputDigest, target, toolchainImage, guestSha256,
    runnerSha256: $sha, runnerSizeBytes: $size
  }' <<<"$CACHE_REFERENCE" > "${transport}/metadata.json"
  chmod 755 "$runner"
  mv "$transport" "$RESOLVE_OUTPUT_DIR"
  emit "runner-size-bytes" "$runner_size"
  emit "object-size-bytes" "$(stat -c '%s' "$compressed")"
  resolve_result "hit" "r2" "downloaded"
}

usage() {
  cat <<'USAGE'
Usage: runner-binary-cache.sh <fresh-validate|artifact-name|manifest-validate|publish|shadow-resolve|resolve-reference|download-reference>
USAGE
}

case "${1:-}" in
  fresh-validate) fresh_validate ;;
  artifact-name) artifact_name ;;
  manifest-validate) manifest_validate ;;
  publish) publish ;;
  shadow-resolve) shadow_resolve ;;
  resolve-reference) resolve_reference ;;
  download-reference) download_reference ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
