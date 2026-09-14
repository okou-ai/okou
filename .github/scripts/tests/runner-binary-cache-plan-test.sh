#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PLAN="${SCRIPT_DIR}/runner-binary-cache-plan.sh"
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

command -v zstd >/dev/null || fail "zstd is required"

arm_target=aarch64-unknown-linux-musl
x86_target=x86_64-unknown-linux-musl
arm_digest=$("${SCRIPT_DIR}/runner-binary-build/digest.sh" "$arm_target" | sed -n 's/^binary-input-digest=//p')
x86_digest=$("${SCRIPT_DIR}/runner-binary-build/digest.sh" "$x86_target" | sed -n 's/^binary-input-digest=//p')
arm_artifact="runner-binary-asset-${arm_target}-${arm_digest}"
x86_artifact="runner-binary-asset-${x86_target}-${x86_digest}"
matrix=$(jq -cn \
  --arg arm_target "$arm_target" \
  --arg x86_target "$x86_target" '[
    {
      id: "arm64", label: "arm64", target: $arm_target, unameM: "aarch64",
      cacheSuffix: "arm64", assetSuffix: "arm64"
    },
    {
      id: "x86_64", label: "x86_64", target: $x86_target, unameM: "x86_64",
      cacheSuffix: "x86_64", assetSuffix: "x86_64"
    }
  ]')

. "${SCRIPT_DIR}/runner-guest-binaries.sh"
. "${REPO_ROOT}/.github/scripts/runner-binary-build/contract.env"
runner_guest_binaries_load
guest_json='{}'
for guest in "${RUNNER_GUEST_BINARIES[@]}"; do
  guest_sha=$(printf '%s' "$guest" | sha256sum | awk '{print $1}')
  guest_json=$(jq -c --arg guest "$guest" --arg sha "$guest_sha" '. + {($guest): $sha}' <<<"$guest_json")
done

mkdir -p "${TMPDIR}/bin" "${TMPDIR}/fixtures" "${TMPDIR}/objects" "${TMPDIR}/runner-temp"
runner="${TMPDIR}/runner"
printf 'runner binary cache plan fixture\n' > "$runner"
runner_sha=$(sha256sum "$runner" | awk '{print $1}')
runner_size=$(stat -c '%s' "$runner")
main_head=$(printf 'b%.0s' {1..40})

create_fixture() {
  local target=$1 digest=$2 name=$3
  local object="${TMPDIR}/objects/${target}.zst"
  zstd -q -3 -f -o "$object" "$runner"
  object_size=$(stat -c '%s' "$object")
  jq -n \
    --arg digest "$digest" \
    --arg target "$target" \
    --arg toolchain "$RUNNER_BINARY_TOOLCHAIN_IMAGE" \
    --argjson guests "$guest_json" \
    --arg object_key "runner-binaries/${target}/${runner_sha}.zst" \
    --argjson object_size "$object_size" '
      {
        schemaVersion: 1,
        binaryInputDigest: $digest,
        target: $target,
        toolchainImage: $toolchain,
        guests: $guests,
        object: {key: $object_key, compression: "zstd", sizeBytes: $object_size},
        createdAt: "2026-07-22T00:00:00Z"
      }
    ' > "${TMPDIR}/fixtures/${name}.json"
}

create_fixture "$arm_target" "$arm_digest" "$arm_artifact"
create_fixture "$x86_target" "$x86_digest" "$x86_artifact"

cat > "${TMPDIR}/bin/gh" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GH_LOG"
if [ "$1" = "api" ]; then
  endpoint="${*: -1}"
  if [[ "$endpoint" == *'/actions/artifacts?'* ]]; then
    name=${endpoint#*name=}
    name=${name%%&*}
    if [ "${GH_SCENARIO:-all-hit}" = "all-miss" ] ||
      { [ "${GH_SCENARIO:-all-hit}" = "mixed" ] && [ "$name" = "$X86_ARTIFACT" ]; }; then
      printf '[{"artifacts":[]}]\n'
    else
      printf '[{"artifacts":[{"id":120,"name":"%s","expired":false,"size_in_bytes":1000,"created_at":"2026-07-22T00:00:00Z","workflow_run":{"id":20,"head_branch":"main","head_sha":"%s"}}]}]\n' \
        "$name" "$MAIN_HEAD"
    fi
    exit 0
  fi
  exit 2
fi
if [ "$1" = "run" ] && [ "$2" = "download" ]; then
  artifact_name=""
  output_dir=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -n) artifact_name=$2; shift 2 ;;
      -D) output_dir=$2; shift 2 ;;
      *) shift ;;
    esac
  done
  mkdir -p "$output_dir"
  cp "${FIXTURES}/${artifact_name}.json" "${output_dir}/manifest.json"
  exit 0
fi
exit 2
BASH
chmod +x "${TMPDIR}/bin/gh"

cat > "${TMPDIR}/bin/aws" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
[ "$1" = "s3api" ] || exit 2
operation=$2
printf '%s\n' "$*" >> "$AWS_LOG"
shift 2
key=""
destination=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --key) key=$2; shift 2 ;;
    --endpoint-url|--bucket|--output|--range|--cli-connect-timeout|--cli-read-timeout) shift 2 ;;
    --*) shift ;;
    *) destination=$1; shift ;;
  esac
done
target=${key#runner-binaries/}
target=${target%%/*}
object="${OBJECTS}/${target}.zst"
case "$operation" in
  head-object) test -f "$object"; printf '{"ContentLength":%s}\n' "$(stat -c '%s' "$object")" ;;
  get-object)
    [ "${AWS_MODE:-success}" != "get-fail" ] || exit 7
    cp "$object" "$destination"
    printf '{}\n'
    ;;
  *) exit 2 ;;
esac
BASH
chmod +x "${TMPDIR}/bin/aws"

run_plan() {
  local scenario=$1 output_dir=$2
  PATH="${TMPDIR}/bin:${PATH}" \
  GH_LOG="${TMPDIR}/gh.log" \
  AWS_LOG="${TMPDIR}/aws.log" \
  GH_SCENARIO="$scenario" \
  FIXTURES="${TMPDIR}/fixtures" \
  OBJECTS="${TMPDIR}/objects" \
  ARM_ARTIFACT="$arm_artifact" \
  X86_ARTIFACT="$x86_artifact" \
  MAIN_HEAD="$main_head" \
  AWS_ACCESS_KEY_ID=test-access \
  AWS_SECRET_ACCESS_KEY=test-secret \
  R2_ACCOUNT_ID=test-account \
  R2_BUCKET_NAME=test-bucket \
  RUNNER_TEMP="${TMPDIR}/runner-temp" \
  REPO=vm0-ai/vm0 \
  RUNNER_HOST_GROUPS_MATRIX="$matrix" \
  RESOLVE_OUTPUT_DIR="$output_dir" \
    "$PLAN"
}

: > "${TMPDIR}/gh.log"
plan_output="${TMPDIR}/plan.output"
plan_summary="${TMPDIR}/plan.summary"
all_hit=$(GITHUB_OUTPUT="$plan_output" \
  GITHUB_STEP_SUMMARY="$plan_summary" \
  run_plan all-hit "${TMPDIR}/all-hit")
assert_contains "$all_hit" 'compile-matrix=[]'
assert_contains "$all_hit" 'hit-count=2'
assert_contains "$all_hit" 'miss-count=0'
assert_contains "$all_hit" 'resolution-json=['
plan_output_keys=$(cut -d= -f1 "$plan_output" | LC_ALL=C sort -u | paste -sd, -)
[ "$plan_output_keys" = "compile-matrix,hit-count,hit-references,hit-targets,miss-count" ] ||
  fail "unexpected plan output keys: ${plan_output_keys}"
grep -qF '### Runner binary cache plan' "$plan_summary" || fail "expected plan summary"
grep -qF "\`${arm_target}\`" "$plan_summary" || fail "expected arm target in plan summary"
grep -qF "\`${x86_target}\`" "$plan_summary" || fail "expected x86 target in plan summary"
references=$(sed -n 's/^hit-references=//p' "$plan_output")
jq -e --arg arm "$arm_target" --arg x86 "$x86_target" \
  'keys == ([$arm, $x86] | sort) and .[$arm].target == $arm and .[$x86].target == $x86' \
  <<<"$references" >/dev/null || fail "each target must receive its own cache reference"
[ "$(wc -l < "${TMPDIR}/aws.log")" -eq 2 ] || fail "prepare should only inspect the two R2 objects"

mixed=$(run_plan mixed "${TMPDIR}/mixed")
assert_contains "$mixed" 'hit-count=1'
assert_contains "$mixed" 'miss-count=1'
mixed_matrix=$(sed -n 's/^compile-matrix=//p' <<<"$mixed")
[ "$(jq -r '.[0].target' <<<"$mixed_matrix")" = "$x86_target" ] || fail "mixed plan must compile x86 only"
[ -f "${TMPDIR}/mixed/${arm_target}/reference.json" ] || fail "mixed plan must resolve the arm hit"
[ ! -e "${TMPDIR}/mixed/${x86_target}" ] || fail "mixed plan must not stage a missed target"

all_miss=$(run_plan all-miss "${TMPDIR}/all-miss")
assert_contains "$all_miss" 'hit-count=0'
assert_contains "$all_miss" 'miss-count=2'
all_miss_matrix=$(sed -n 's/^compile-matrix=//p' <<<"$all_miss")
[ "$(jq 'length' <<<"$all_miss_matrix")" -eq 2 ] || fail "all-miss plan must compile both targets"

: > "${TMPDIR}/gh.log"
forced=$(RUNNER_BINARY_CACHE_FORCE_MISS=true run_plan all-hit "${TMPDIR}/forced")
assert_contains "$forced" 'hit-count=0'
assert_contains "$forced" 'miss-count=2'
assert_contains "$forced" '"reason":"force-miss"'
[ ! -s "${TMPDIR}/gh.log" ] || fail "force-miss plan must not query GitHub"

run_download() {
  local target=$1 digest=$2 output_dir=$3 mode=${4:-success}
  PATH="${TMPDIR}/bin:${PATH}" \
  AWS_LOG="${TMPDIR}/aws.log" \
  AWS_MODE="$mode" \
  OBJECTS="${TMPDIR}/objects" \
  AWS_ACCESS_KEY_ID=test-access \
  AWS_SECRET_ACCESS_KEY=test-secret \
  R2_ACCOUNT_ID=test-account \
  R2_BUCKET_NAME=test-bucket \
  RUNNER_TEMP="${TMPDIR}/runner-temp" \
  EXPECTED_TARGET="$target" \
  EXPECTED_BINARY_INPUT_DIGEST="$digest" \
  CACHE_REFERENCE="$(jq -c --arg target "$target" '.[$target]' <<<"$references")" \
  RESOLVE_OUTPUT_DIR="$output_dir" \
    "${SCRIPT_DIR}/runner-binary-cache.sh" download-reference
}

: > "${TMPDIR}/aws.log"
arm_download=$(run_download "$arm_target" "$arm_digest" "${TMPDIR}/download-arm")
x86_download=$(run_download "$x86_target" "$x86_digest" "${TMPDIR}/download-x86")
assert_contains "$arm_download" 'resolve-outcome=hit'
assert_contains "$x86_download" 'resolve-outcome=hit'
assert_contains "$arm_download" "runner-size-bytes=${runner_size}"
cmp "$runner" "${TMPDIR}/download-arm/runner" || fail "arm build must receive cached bytes"
cmp "$runner" "${TMPDIR}/download-x86/runner" || fail "x86 build must receive cached bytes"
[ "$(wc -l < "${TMPDIR}/aws.log")" -eq 2 ] || fail "builds should perform one R2 download per target"
[ "$(grep -c 's3api get-object' "${TMPDIR}/aws.log")" -eq 2 ] || fail "expected two target downloads"
FRESH_METADATA_PATH="${TMPDIR}/download-arm/metadata.json" \
RUNNER_PATH="${TMPDIR}/download-arm/runner" \
EXPECTED_TARGET="$arm_target" \
EXPECTED_BINARY_INPUT_DIGEST="$arm_digest" \
  "${SCRIPT_DIR}/runner-binary-cache.sh" fresh-validate >/dev/null

mv "${TMPDIR}/objects/${arm_target}.zst" "${TMPDIR}/arm-unavailable.zst"
unavailable=$(run_plan all-hit "${TMPDIR}/unavailable")
assert_contains "$unavailable" 'hit-count=1'
assert_contains "$unavailable" 'miss-count=1'
unavailable_matrix=$(sed -n 's/^compile-matrix=//p' <<<"$unavailable")
[ "$(jq -r '.[0].target' <<<"$unavailable_matrix")" = "$arm_target" ] || fail "missing arm object must select arm compilation"
if run_download "$arm_target" "$arm_digest" "${TMPDIR}/late-missing" >/dev/null 2>&1; then
  fail "a selected object that disappears must fail the download"
fi
[ ! -e "${TMPDIR}/late-missing" ] || fail "failed download must not expose partial transport"
mv "${TMPDIR}/arm-unavailable.zst" "${TMPDIR}/objects/${arm_target}.zst"

if run_download "$arm_target" "$arm_digest" "${TMPDIR}/download-failed" get-fail >/dev/null 2>&1; then
  fail "a required cache download failure must propagate"
fi
[ ! -e "${TMPDIR}/download-failed" ] || fail "failed download must not expose partial transport"

mkdir -p "${TMPDIR}/timeout-bin"
cat > "${TMPDIR}/timeout-bin/timeout" <<'BASH'
#!/usr/bin/env bash
exit "${TIMEOUT_STATUS:-124}"
BASH
chmod +x "${TMPDIR}/timeout-bin/timeout"
timed_out=$(PATH="${TMPDIR}/timeout-bin:${TMPDIR}/bin:${PATH}" \
  GH_LOG="${TMPDIR}/gh.log" \
  RUNNER_HOST_GROUPS_MATRIX="$matrix" \
  RESOLVE_OUTPUT_DIR="${TMPDIR}/timed-out" \
  REPO=vm0-ai/vm0 \
  "$PLAN")
assert_contains "$timed_out" 'hit-count=0'
assert_contains "$timed_out" 'miss-count=2'
assert_contains "$timed_out" '"reason":"resolve-timeout"'

killed=$(TIMEOUT_STATUS=137 \
  PATH="${TMPDIR}/timeout-bin:${TMPDIR}/bin:${PATH}" \
  GH_LOG="${TMPDIR}/gh.log" \
  RUNNER_HOST_GROUPS_MATRIX="$matrix" \
  RESOLVE_OUTPUT_DIR="${TMPDIR}/killed" \
  REPO=vm0-ai/vm0 \
  "$PLAN")
assert_contains "$killed" 'hit-count=0'
assert_contains "$killed" 'miss-count=2'
assert_contains "$killed" '"reason":"resolve-timeout"'

echo "runner-binary-cache-plan-test: ok"
