#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CACHE="${SCRIPT_DIR}/runner-binary-cache.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_contains() {
  local output=$1 expected=$2
  grep -qF "$expected" <<<"$output" || fail "expected '${expected}' in: ${output}"
}

assert_output_keys() {
  local file=$1 expected=$2 actual
  actual=$(cut -d= -f1 "$file" | LC_ALL=C sort -u | paste -sd, -)
  [ "$actual" = "$expected" ] ||
    fail "expected output keys '${expected}', got '${actual}'"
}

assert_fails() {
  local name=$1
  shift
  if "$@" >/dev/null 2>&1; then
    fail "expected failure: ${name}"
  fi
}

command -v zstd >/dev/null || fail "zstd is required"

. "${SCRIPT_DIR}/runner-guest-binaries.sh"
. "${REPO_ROOT}/.github/scripts/runner-binary-build/contract.env"
runner_guest_binaries_load

runner="${TMPDIR}/runner"
printf 'runner binary fixture\n' > "$runner"
runner_sha=$(sha256sum "$runner" | awk '{print $1}')
runner_size=$(stat -c '%s' "$runner")
input_digest=$(printf 'a%.0s' {1..64})
head_sha=$(printf 'b%.0s' {1..40})
target=aarch64-unknown-linux-musl
guest_json=$(jq -n '{}')
for guest in "${RUNNER_GUEST_BINARIES[@]}"; do
  guest_sha=$(printf '%s' "$guest" | sha256sum | awk '{print $1}')
  guest_json=$(jq -c --arg guest "$guest" --arg sha "$guest_sha" '. + {($guest): $sha}' <<<"$guest_json")
done

fresh="${TMPDIR}/fresh.json"
jq -n \
  --arg digest "$input_digest" \
  --arg target "$target" \
  --arg toolchain "$RUNNER_BINARY_TOOLCHAIN_IMAGE" \
  --arg sha "$runner_sha" \
  --argjson size "$runner_size" \
  --argjson guests "$guest_json" '
    {
      schemaVersion: 1,
      binaryInputDigest: $digest,
      target: $target,
      toolchainImage: $toolchain,
      runnerSha256: $sha,
      runnerSizeBytes: $size,
      guestSha256: $guests
    }
  ' > "$fresh"

fresh_out=$(FRESH_METADATA_PATH="$fresh" \
  RUNNER_PATH="$runner" \
  EXPECTED_TARGET="$target" \
  EXPECTED_BINARY_INPUT_DIGEST="$input_digest" \
  "$CACHE" fresh-validate)
assert_contains "$fresh_out" "runner-sha=${runner_sha}"
assert_contains "$fresh_out" "runner-size-bytes=${runner_size}"

artifact_out=$(EXPECTED_TARGET="$target" \
  EXPECTED_BINARY_INPUT_DIGEST="$input_digest" \
  "$CACHE" artifact-name)
assert_contains "$artifact_out" \
  "artifact-name=runner-binary-asset-${target}-${input_digest}"
assert_fails "artifact name rejects an invalid input digest" \
  env EXPECTED_TARGET="$target" \
  EXPECTED_BINARY_INPUT_DIGEST=invalid \
  "$CACHE" artifact-name

jq '.unexpected = true' "$fresh" > "${TMPDIR}/fresh-extra.json"
assert_fails "fresh metadata rejects unknown fields" \
  env FRESH_METADATA_PATH="${TMPDIR}/fresh-extra.json" \
  RUNNER_PATH="$runner" \
  EXPECTED_TARGET="$target" \
  EXPECTED_BINARY_INPUT_DIGEST="$input_digest" \
  "$CACHE" fresh-validate

printf 'changed runner\n' > "${TMPDIR}/wrong-runner"
assert_fails "fresh metadata verifies runner bytes" \
  env FRESH_METADATA_PATH="$fresh" \
  RUNNER_PATH="${TMPDIR}/wrong-runner" \
  EXPECTED_TARGET="$target" \
  EXPECTED_BINARY_INPUT_DIGEST="$input_digest" \
  "$CACHE" fresh-validate

mkdir -p "${TMPDIR}/bin" "${TMPDIR}/store" "${TMPDIR}/runner-temp"
cat > "${TMPDIR}/bin/aws" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$AWS_LOG"
[ "$1" = "s3api" ] || exit 2
operation=$2
shift 2
body=""
destination=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --body) body=$2; shift 2 ;;
    --endpoint-url|--bucket|--key|--content-type|--cache-control|--if-none-match|--output|--range|--cli-connect-timeout|--cli-read-timeout)
      shift 2
      ;;
    --*) shift ;;
    *) destination=$1; shift ;;
  esac
done
object="${AWS_STORE}/object.zst"
case "$operation" in
  put-object)
    if [ "${AWS_MODE:-success}" = "put-fail" ]; then
      echo 'request failed X-Amz-Signature=supersecret' >&2
      exit 9
    fi
    if [ -f "$object" ]; then
      echo 'PreconditionFailed: 412' >&2
      exit 1
    fi
    cp "$body" "$object"
    printf '{}\n'
    ;;
  head-object)
    [ -f "$object" ] || exit 1
    case "${AWS_MODE:-success}" in
      head-fail) exit 6 ;;
      malformed-head) printf 'not-json\n' ;;
      oversized-head) printf '{"ContentLength":67108865}\n' ;;
      size-mismatch) printf '{"ContentLength":1}\n' ;;
      *) printf '{"ContentLength":%s}\n' "$(stat -c '%s' "$object")" ;;
    esac
    ;;
  get-object)
    [ "${AWS_MODE:-success}" != "get-fail" ] || exit 7
    [ -f "$object" ] || exit 1
    cp "$object" "$destination"
    printf '{}\n'
    ;;
  *) exit 2 ;;
esac
BASH
chmod +x "${TMPDIR}/bin/aws"

run_publish() {
  local output_dir=$1 mode=${2:-success}
  PATH="${TMPDIR}/bin:${PATH}" \
  AWS_LOG="${TMPDIR}/aws.log" \
  AWS_MODE="$mode" \
  AWS_STORE="${TMPDIR}/store" \
  AWS_ACCESS_KEY_ID=test-access \
  AWS_SECRET_ACCESS_KEY=test-secret \
  R2_ACCOUNT_ID=test-account \
  R2_BUCKET_NAME=test-bucket \
  RUNNER_TEMP="${TMPDIR}/runner-temp" \
  FRESH_METADATA_PATH="$fresh" \
  RUNNER_PATH="$runner" \
  EXPECTED_TARGET="$target" \
  EXPECTED_BINARY_INPUT_DIGEST="$input_digest" \
  OUTPUT_DIR="$output_dir" \
  PRODUCER_REPOSITORY=vm0-ai/vm0 \
  PRODUCER_WORKFLOW_PATH=.github/workflows/runner-image.yml \
  PRODUCER_RUN_ID=10 \
  PRODUCER_RUN_ATTEMPT=1 \
  PRODUCER_EVENT=pull_request \
  PRODUCER_HEAD_SHA="$head_sha" \
  PRODUCER_PR_NUMBER=123 \
    "$CACHE" publish
}

: > "${TMPDIR}/aws.log"
publish_output="${TMPDIR}/publish.output"
publish_out=$(GITHUB_OUTPUT="$publish_output" run_publish "${TMPDIR}/published")
assert_contains "$publish_out" "published=true"
assert_contains "$publish_out" "publish-reason=uploaded"
assert_output_keys "$publish_output" \
  "manifest-path,object-key,object-size-bytes,publish-reason,published"
[ -f "${TMPDIR}/published/manifest.json" ] || fail "expected reusable manifest"
zstd -q -d -c "${TMPDIR}/store/object.zst" > "${TMPDIR}/stored-runner"
cmp -s "$runner" "${TMPDIR}/stored-runner" || fail "R2 object must contain the fresh runner"
if ! grep -F 's3api head-object' "${TMPDIR}/aws.log" |
  grep -qF -- '--cli-connect-timeout 5 --cli-read-timeout 30'; then
  fail "R2 HEAD validation must use bounded AWS timeouts"
fi
if ! grep -F 's3api get-object' "${TMPDIR}/aws.log" |
  grep -qF -- '--cli-connect-timeout 5 --cli-read-timeout 30'; then
  fail "R2 GET validation must use bounded AWS timeouts"
fi

MANIFEST_PATH="${TMPDIR}/published/manifest.json" \
EXPECTED_TARGET="$target" \
EXPECTED_BINARY_INPUT_DIGEST="$input_digest" \
EXPECTED_REPOSITORY=vm0-ai/vm0 \
EXPECTED_WORKFLOW_PATH=.github/workflows/runner-image.yml \
  "$CACHE" manifest-validate >/dev/null

assert_reusable_manifest_fails() {
  local name=$1 manifest=$2
  assert_fails "$name" \
    env MANIFEST_PATH="$manifest" \
    EXPECTED_TARGET="$target" \
    EXPECTED_BINARY_INPUT_DIGEST="$input_digest" \
    EXPECTED_REPOSITORY=vm0-ai/vm0 \
    EXPECTED_WORKFLOW_PATH=.github/workflows/runner-image.yml \
    "$CACHE" manifest-validate
}

jq '.extra = true' "${TMPDIR}/published/manifest.json" > "${TMPDIR}/manifest-extra.json"
assert_reusable_manifest_fails \
  "reusable manifest rejects unknown fields" \
  "${TMPDIR}/manifest-extra.json"

wrong_target=x86_64-unknown-linux-musl
jq --arg target "$wrong_target" '
  .target = $target |
  .object.key = ("runner-binaries/" + $target + "/" + .runner.sha256 + ".zst")
' "${TMPDIR}/published/manifest.json" > "${TMPDIR}/manifest-wrong-target.json"
assert_reusable_manifest_fails \
  "reusable manifest binds the requested target" \
  "${TMPDIR}/manifest-wrong-target.json"

wrong_digest=$(printf '0%.0s' {1..64})
jq --arg digest "$wrong_digest" '.binaryInputDigest = $digest' \
  "${TMPDIR}/published/manifest.json" > "${TMPDIR}/manifest-wrong-digest.json"
assert_reusable_manifest_fails \
  "reusable manifest binds the requested input digest" \
  "${TMPDIR}/manifest-wrong-digest.json"

jq '.toolchainImage = "ghcr.io/untrusted/toolchain:latest"' \
  "${TMPDIR}/published/manifest.json" > "${TMPDIR}/manifest-wrong-toolchain.json"
assert_reusable_manifest_fails \
  "reusable manifest binds the immutable toolchain" \
  "${TMPDIR}/manifest-wrong-toolchain.json"

jq '.runner.sizeBytes = 0' \
  "${TMPDIR}/published/manifest.json" > "${TMPDIR}/manifest-invalid-runner-size.json"
assert_reusable_manifest_fails \
  "reusable manifest rejects an invalid runner size" \
  "${TMPDIR}/manifest-invalid-runner-size.json"

jq '.runner.sha256 = "invalid"' \
  "${TMPDIR}/published/manifest.json" > "${TMPDIR}/manifest-invalid-runner-sha.json"
assert_reusable_manifest_fails \
  "reusable manifest rejects an invalid runner sha" \
  "${TMPDIR}/manifest-invalid-runner-sha.json"

jq '.object.sizeBytes = 0' \
  "${TMPDIR}/published/manifest.json" > "${TMPDIR}/manifest-invalid-object-size.json"
assert_reusable_manifest_fails \
  "reusable manifest rejects an invalid object size" \
  "${TMPDIR}/manifest-invalid-object-size.json"

jq '.object.compression = "gzip"' \
  "${TMPDIR}/published/manifest.json" > "${TMPDIR}/manifest-wrong-compression.json"
assert_reusable_manifest_fails \
  "reusable manifest rejects unsupported compression" \
  "${TMPDIR}/manifest-wrong-compression.json"

jq '.producer.repository = "untrusted/repository"' \
  "${TMPDIR}/published/manifest.json" > "${TMPDIR}/manifest-wrong-repository.json"
assert_reusable_manifest_fails \
  "reusable manifest binds the producer repository" \
  "${TMPDIR}/manifest-wrong-repository.json"

jq '.producer.workflowPath = ".github/workflows/untrusted.yml"' \
  "${TMPDIR}/published/manifest.json" > "${TMPDIR}/manifest-wrong-workflow.json"
assert_reusable_manifest_fails \
  "reusable manifest binds the producer workflow" \
  "${TMPDIR}/manifest-wrong-workflow.json"

first_guest="${RUNNER_GUEST_BINARIES[0]}"
jq --arg guest "$first_guest" 'del(.guests[$guest])' \
  "${TMPDIR}/published/manifest.json" > "${TMPDIR}/manifest-missing-guest.json"
assert_reusable_manifest_fails \
  "reusable manifest requires complete guests" \
  "${TMPDIR}/manifest-missing-guest.json"

jq '.object.key = "runner-binaries/wrong.zst"' \
  "${TMPDIR}/published/manifest.json" > "${TMPDIR}/manifest-wrong-key.json"
assert_reusable_manifest_fails \
  "reusable manifest binds the R2 key" \
  "${TMPDIR}/manifest-wrong-key.json"

existing_out=$(run_publish "${TMPDIR}/existing")
assert_contains "$existing_out" "published=true"
assert_contains "$existing_out" "publish-reason=existing-validated"

printf 'not zstd\n' > "${TMPDIR}/store/object.zst"
assert_publish_failure() {
  local directory=$1 mode=$2 reason=$3 output
  if output=$(run_publish "$directory" "$mode" 2>&1); then
    fail "expected required publication failure: ${reason}"
  fi
  assert_contains "$output" "publication failed (${reason})"
  [ ! -e "${directory}/manifest.json" ] || fail "failed publication must not advertise a manifest"
  if grep -q 'supersecret' <<<"$output"; then
    fail "publication diagnostics leaked AWS error query material"
  fi
}
assert_publish_failure "${TMPDIR}/corrupt" success decompression-invalid

printf 'different runner binary fixture\n' > "${TMPDIR}/different-runner"
zstd -q -3 -f -o "${TMPDIR}/store/object.zst" "${TMPDIR}/different-runner"
assert_publish_failure "${TMPDIR}/publish-content-mismatch" success retained-content-mismatch

rm -f "${TMPDIR}/store/object.zst"
assert_publish_failure "${TMPDIR}/put-failure" put-fail put-failed

zstd -q -3 -f -o "${TMPDIR}/store/object.zst" "$runner"
assert_publish_failure "${TMPDIR}/oversized" oversized-head retained-size-invalid
assert_publish_failure "${TMPDIR}/malformed-head" malformed-head head-malformed

if missing_config=$(FRESH_METADATA_PATH="$fresh" \
  RUNNER_PATH="$runner" \
  EXPECTED_TARGET="$target" \
  EXPECTED_BINARY_INPUT_DIGEST="$input_digest" \
  OUTPUT_DIR="${TMPDIR}/missing-config" \
  PRODUCER_REPOSITORY=vm0-ai/vm0 \
  PRODUCER_RUN_ID=10 \
  PRODUCER_RUN_ATTEMPT=1 \
  PRODUCER_EVENT=pull_request \
  PRODUCER_HEAD_SHA="$head_sha" \
  PRODUCER_PR_NUMBER=123 \
    "$CACHE" publish 2>&1); then
  fail "required publication must fail without R2 configuration"
fi
assert_contains "$missing_config" "publication failed (missing-r2-config)"

main_head=$(printf 'c%.0s' {1..40})
pr_head=$(printf 'd%.0s' {1..40})
reachable_head=$(printf '1%.0s' {1..40})
unreachable_head=$(printf '2%.0s' {1..40})
main_manifest="${TMPDIR}/main-manifest.json"
pr_manifest="${TMPDIR}/pr-manifest.json"
failed_main_manifest="${TMPDIR}/failed-main-manifest.json"
reachable_manifest="${TMPDIR}/reachable-manifest.json"
jq --arg head "$main_head" '
  .producer.runId = 20 |
  .producer.event = "push" |
  .producer.headSha = $head |
  .producer.prNumber = null
' "${TMPDIR}/published/manifest.json" > "$main_manifest"
jq --arg head "$pr_head" '
  .producer.runId = 21 |
  .producer.event = "pull_request" |
  .producer.headSha = $head |
  .producer.prNumber = 123
' "${TMPDIR}/published/manifest.json" > "$pr_manifest"
jq '.producer.runId = 22' "$main_manifest" > "$failed_main_manifest"
jq --arg head "$reachable_head" '
  .producer.runId = 24 |
  .producer.event = "merge_group" |
  .producer.headSha = $head |
  .producer.prNumber = 456
' "${TMPDIR}/published/manifest.json" > "$reachable_manifest"

jq '.producer.runId = 999' "$main_manifest" > "${TMPDIR}/untrusted-manifest.json"

conflict_sha=$(printf 'e%.0s' {1..64})
jq --arg sha "$conflict_sha" '
  .runner.sha256 = $sha |
  .object.key = ("runner-binaries/" + .target + "/" + $sha + ".zst")
' "$main_manifest" > "${TMPDIR}/conflict-manifest.json"
guest_conflict_sha=$(printf 'f%.0s' {1..64})
jq --arg guest "$first_guest" --arg sha "$guest_conflict_sha" \
  '.guests[$guest] = $sha' \
  "$main_manifest" > "${TMPDIR}/guest-conflict-manifest.json"

cat > "${TMPDIR}/run-20.json" <<JSON
{"id":20,"run_attempt":1,"event":"push","status":"completed","conclusion":"success","head_branch":"main","head_sha":"${main_head}","path":".github/workflows/runner-image.yml","repository":{"full_name":"vm0-ai/vm0"},"pull_requests":[]}
JSON
cat > "${TMPDIR}/run-21.json" <<JSON
{"id":21,"run_attempt":1,"event":"pull_request","status":"completed","conclusion":"success","head_branch":"feature","head_sha":"${pr_head}","path":".github/workflows/runner-image.yml","repository":{"full_name":"vm0-ai/vm0"},"pull_requests":[{"number":123}]}
JSON
cat > "${TMPDIR}/run-22.json" <<JSON
{"id":22,"run_attempt":1,"event":"push","status":"completed","conclusion":"failure","head_branch":"main","head_sha":"${main_head}","path":".github/workflows/runner-image.yml","repository":{"full_name":"vm0-ai/vm0"},"pull_requests":[]}
JSON
cat > "${TMPDIR}/run-24.json" <<JSON
{"id":24,"run_attempt":1,"event":"merge_group","status":"completed","conclusion":"failure","head_branch":"gh-readonly-queue/main/pr-456-deadbeef","head_sha":"${reachable_head}","path":".github/workflows/runner-image.yml","repository":{"full_name":"vm0-ai/vm0"},"pull_requests":[]}
JSON
cat > "${TMPDIR}/run-30.json" <<JSON
{"id":30,"run_attempt":1,"event":"pull_request","status":"completed","conclusion":"success","head_branch":"other","head_sha":"${unreachable_head}","path":".github/workflows/runner-image.yml","repository":{"full_name":"vm0-ai/vm0"},"pull_requests":[{"number":999}]}
JSON

cat > "${TMPDIR}/bin/gh" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GH_LOG"
if [ "$1" = "api" ]; then
  endpoint="${*: -1}"
  if [[ "$endpoint" == *'/actions/artifacts?'* ]]; then
    [ "${GH_SCENARIO:-rank}" != "api-fail" ] || exit 8
    case "${GH_SCENARIO:-rank}" in
      failed)
        printf '[{"artifacts":[{"id":122,"name":"%s","expired":false,"size_in_bytes":1000,"created_at":"2026-07-21T00:00:00Z","workflow_run":{"id":22,"head_branch":"main","head_sha":"%s"}}]}]\n' "$EXPECTED_ARTIFACT_NAME" "$MAIN_HEAD"
        ;;
      failed-valid)
        printf '[{"artifacts":[{"id":122,"name":"%s","expired":false,"size_in_bytes":1000,"created_at":"2026-07-21T00:00:00Z","workflow_run":{"id":22,"head_branch":"main","head_sha":"%s"}}]}]\n' "$EXPECTED_ARTIFACT_NAME" "$MAIN_HEAD"
        ;;
      ranking-reachable)
        printf '[{"artifacts":[{"id":124,"name":"%s","expired":false,"size_in_bytes":1000,"created_at":"2026-07-21T02:00:00Z","workflow_run":{"id":24,"head_branch":"gh-readonly-queue/main/pr-456-deadbeef","head_sha":"%s"}},{"id":121,"name":"%s","expired":false,"size_in_bytes":1000,"created_at":"2026-07-21T01:00:00Z","workflow_run":{"id":21,"head_branch":"feature","head_sha":"%s"}}]}]\n' \
          "$EXPECTED_ARTIFACT_NAME" "$REACHABLE_HEAD" \
          "$EXPECTED_ARTIFACT_NAME" "$PR_HEAD"
        ;;
      untrusted)
        printf '[{"artifacts":[{"id":120,"name":"%s","expired":false,"size_in_bytes":1000,"created_at":"2026-07-21T00:00:00Z","workflow_run":{"id":20,"head_branch":"main","head_sha":"%s"}}]}]\n' "$EXPECTED_ARTIFACT_NAME" "$MAIN_HEAD"
        ;;
      empty)
        printf '[{"artifacts":[]}]\n'
        ;;
      *)
        printf '[{"artifacts":[{"id":199,"name":"%s","expired":false,"size_in_bytes":1000,"created_at":"2026-07-21T03:00:00Z","workflow_run":{"id":99,"head_branch":"feature","head_sha":"%s"}},{"id":130,"name":"%s","expired":false,"size_in_bytes":1000,"created_at":"2026-07-21T02:30:00Z","workflow_run":{"id":30,"head_branch":"other","head_sha":"%s"}},{"id":121,"name":"%s","expired":false,"size_in_bytes":1000,"created_at":"2026-07-21T02:00:00Z","workflow_run":{"id":21,"head_branch":"feature","head_sha":"%s"}}]},{"artifacts":[{"id":120,"name":"%s","expired":false,"size_in_bytes":1000,"created_at":"2026-07-21T01:00:00Z","workflow_run":{"id":20,"head_branch":"main","head_sha":"%s"}}]}]\n' \
          "$EXPECTED_ARTIFACT_NAME" "$PR_HEAD" \
          "$EXPECTED_ARTIFACT_NAME" "$UNREACHABLE_HEAD" \
          "$EXPECTED_ARTIFACT_NAME" "$PR_HEAD" \
          "$EXPECTED_ARTIFACT_NAME" "$MAIN_HEAD"
        ;;
    esac
    exit 0
  fi
  if [[ "$endpoint" == *'/compare/'* ]]; then
    case "${GH_SCENARIO:-rank}" in

      rank)
        printf '{"status":"diverged","ahead_by":1,"behind_by":1,"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"}}\n' "$UNREACHABLE_HEAD" "$MAIN_HEAD"
        ;;
      ranking-reachable)
        printf '{"status":"ahead","ahead_by":3,"behind_by":0,"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"}}\n' "$REACHABLE_HEAD" "$REACHABLE_HEAD"
        ;;
      *) exit 2 ;;
    esac
    exit 0
  fi
  run_id=${endpoint##*/}
  cp "${GH_FIXTURES}/run-${run_id}.json" /dev/stdout
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "download" ]; then
  run_id=$3
  output_dir=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -D) output_dir=$2; shift 2 ;;
      *) shift ;;
    esac
  done
  mkdir -p "$output_dir"
  if [ "$run_id" = "20" ] && [ "${GH_SCENARIO:-rank}" = "untrusted" ]; then
    cp "${GH_FIXTURES}/untrusted-manifest.json" "${output_dir}/manifest.json"
  elif [ "$run_id" = "20" ] && [ "${GH_SCENARIO:-rank}" = "conflict" ]; then
    cp "${GH_FIXTURES}/conflict-manifest.json" "${output_dir}/manifest.json"
  elif [ "$run_id" = "20" ] && [ "${GH_SCENARIO:-rank}" = "guest-conflict" ]; then
    cp "${GH_FIXTURES}/guest-conflict-manifest.json" "${output_dir}/manifest.json"
  elif [ "$run_id" = "20" ]; then
    cp "${GH_FIXTURES}/main-manifest.json" "${output_dir}/manifest.json"
  elif [ "$run_id" = "21" ]; then
    cp "${GH_FIXTURES}/pr-manifest.json" "${output_dir}/manifest.json"
  elif [ "$run_id" = "22" ] && [ "${GH_SCENARIO:-rank}" = "failed-valid" ]; then
    cp "${GH_FIXTURES}/failed-main-manifest.json" "${output_dir}/manifest.json"
  elif [ "$run_id" = "24" ]; then
    cp "${GH_FIXTURES}/reachable-manifest.json" "${output_dir}/manifest.json"
  else
    exit 1
  fi
  exit 0
fi
exit 2
BASH
chmod +x "${TMPDIR}/bin/gh"

expected_artifact="runner-binary-asset-${target}-${input_digest}"
run_shadow() {
  local current_event=$1 scenario=$2 output_dir=$3
  local current_pr_number=123 current_pr_head_ref=feature
  if [ "$current_event" = "push" ]; then
    current_pr_number=""
    current_pr_head_ref=""
  fi
  PATH="${TMPDIR}/bin:${PATH}" \
  GH_LOG="${TMPDIR}/gh.log" \
  GH_SCENARIO="$scenario" \
  GH_FIXTURES="$TMPDIR" \
  EXPECTED_ARTIFACT_NAME="$expected_artifact" \
  MAIN_HEAD="$main_head" \
  PR_HEAD="$pr_head" \
  REACHABLE_HEAD="$reachable_head" \
  UNREACHABLE_HEAD="$unreachable_head" \
  FRESH_METADATA_PATH="$fresh" \
  RUNNER_PATH="$runner" \
  EXPECTED_TARGET="$target" \
  EXPECTED_BINARY_INPUT_DIGEST="$input_digest" \
  REPO=vm0-ai/vm0 \
  CURRENT_RUN_ID=99 \
  CURRENT_EVENT="$current_event" \
  CURRENT_PR_NUMBER="$current_pr_number" \
  CURRENT_PR_HEAD_REF="$current_pr_head_ref" \
  DEFAULT_BRANCH=main \
  SHADOW_OUTPUT_DIR="$output_dir" \
    "$CACHE" shadow-resolve
}

: > "${TMPDIR}/gh.log"
shadow_output="${TMPDIR}/shadow.output"
pr_shadow=$(GITHUB_OUTPUT="$shadow_output" run_shadow pull_request rank "${TMPDIR}/shadow-pr")
assert_contains "$pr_shadow" "shadow-outcome=hit"
assert_contains "$pr_shadow" "shadow-source=protected-main"
assert_contains "$pr_shadow" "shadow-producer-run-id=20"
assert_output_keys "$shadow_output" \
  "shadow-outcome,shadow-producer-run-id,shadow-reason,shadow-source"
grep -qE 'actions/runs/99([^0-9]|$)' "${TMPDIR}/gh.log" &&
  fail "shadow resolution queried the current run"

if run_shadow unsupported rank "${TMPDIR}/shadow-invalid-context" \
  > "${TMPDIR}/shadow-invalid-context.out" \
  2> "${TMPDIR}/shadow-invalid-context.err"; then
  fail "shadow resolution accepted an unsupported current event"
fi
grep -qF 'unsupported current event: unsupported' \
  "${TMPDIR}/shadow-invalid-context.err" || fail "expected shadow context diagnostic"

merge_shadow=$(run_shadow merge_group rank "${TMPDIR}/shadow-merge")
assert_contains "$merge_shadow" "shadow-outcome=hit"
assert_contains "$merge_shadow" "shadow-source=same-pr"
assert_contains "$merge_shadow" "shadow-producer-run-id=21"

pr_reachable_rank=$(run_shadow pull_request ranking-reachable "${TMPDIR}/shadow-pr-reachable-rank")
assert_contains "$pr_reachable_rank" "shadow-source=main-reachable"
assert_contains "$pr_reachable_rank" "shadow-producer-run-id=24"

merge_reachable_rank=$(run_shadow merge_group ranking-reachable "${TMPDIR}/shadow-merge-reachable-rank")
assert_contains "$merge_reachable_rank" "shadow-source=same-pr"
assert_contains "$merge_reachable_rank" "shadow-producer-run-id=21"

push_shadow=$(run_shadow push rank "${TMPDIR}/shadow-push")
assert_contains "$push_shadow" "shadow-source=protected-main"

api_failure=$(run_shadow pull_request api-fail "${TMPDIR}/shadow-api-failure")
assert_contains "$api_failure" "shadow-outcome=error"
assert_contains "$api_failure" "shadow-reason=artifact-api-unavailable"

failed_candidate=$(run_shadow pull_request failed "${TMPDIR}/shadow-failed")
assert_contains "$failed_candidate" "shadow-outcome=miss"
assert_contains "$failed_candidate" "shadow-reason=no-trusted-candidate"

failed_valid_candidate=$(run_shadow pull_request failed-valid "${TMPDIR}/shadow-failed-valid")
assert_contains "$failed_valid_candidate" "shadow-outcome=hit"
assert_contains "$failed_valid_candidate" "shadow-source=protected-main"

untrusted_candidate=$(run_shadow pull_request untrusted "${TMPDIR}/shadow-untrusted")
assert_contains "$untrusted_candidate" "shadow-outcome=miss"
assert_contains "$untrusted_candidate" "shadow-reason=no-trusted-candidate"

empty_candidate=$(run_shadow pull_request empty "${TMPDIR}/shadow-empty")
assert_contains "$empty_candidate" "shadow-outcome=miss"

if run_shadow pull_request conflict "${TMPDIR}/shadow-conflict" \
  > "${TMPDIR}/conflict.out" 2> "${TMPDIR}/conflict.err"; then
  fail "expected equal-input output conflict to fail"
fi
grep -q 'equal runner binary input digest produced conflicting output identity' \
  "${TMPDIR}/conflict.err" || fail "expected conflict diagnostic"

if run_shadow pull_request guest-conflict "${TMPDIR}/shadow-guest-conflict" \
  > "${TMPDIR}/guest-conflict.out" 2> "${TMPDIR}/guest-conflict.err"; then
  fail "expected equal-input guest output conflict to fail"
fi
grep -q 'equal runner binary input digest produced conflicting output identity' \
  "${TMPDIR}/guest-conflict.err" || fail "expected guest conflict diagnostic"

echo "runner-binary-cache-test: ok"
