#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RECHECK="${SCRIPT_DIR}/runner-binary-cache-recheck.sh"
TRANSPORT="${SCRIPT_DIR}/runner-binary-transport.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
# shellcheck source=.github/scripts/runner-binary-build/contract.env
. "${SCRIPT_DIR}/runner-binary-build/contract.env"
guests=$(jq --arg sha "$(printf 'a%.0s' {1..64})" \
  'map({key: .binary, value: $sha}) | from_entries' "${REPO_ROOT}/crates/runner/guest-binaries.json")
mkdir -p "${work}/bin" "${work}/store"
export REAL_TIMEOUT
REAL_TIMEOUT=$(command -v timeout)
cat > "${work}/bin/timeout" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
if [ "${2:-}" = 15s ]; then
  [ "$1" = --kill-after=5s ] || exit 2
  case "${LOOKUP_MODE:-normal}" in
    deadline) exit 124 ;;
    kill-deadline) exit 137 ;;
    cancelled) exit 143 ;;
    malformed) printf 'resolve-outcome=unexpected\nresolve-reason=reference\n'; exit 0 ;;
    incomplete) printf 'resolve-outcome=hit\nresolve-reason=reference\nresolve-producer-run-id=11\n'; exit 0 ;;
  esac
fi
exec "$REAL_TIMEOUT" "$@"
BASH
cat > "${work}/bin/gh" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GH_LOG"
case "$1:$2" in
  api:*)
    [ "${GH_MODE:-ready}" != unavailable ] || exit 7
    if [ "${GH_MODE:-ready}" = block ]; then
      echo "$$" > "$BLOCK_FILE"
      exec sleep 60
    fi
    if [ "${GH_MODE:-ready}" = miss ]; then
      printf '[{"artifacts":[]}]\n'
    else
      jq -cn --arg name "$ARTIFACT" --argjson expired "${EXPIRED:-false}" '
        [{artifacts:[{id:1,name:$name,expired:$expired,size_in_bytes:1000,
          created_at:"2026-10-09T00:00:00Z",workflow_run:{id:11}}]}]'
    fi
    ;;
  run:download)
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -D) destination=$2; shift 2 ;;
        *) shift ;;
      esac
    done
    cp "$INDEX_MANIFEST" "${destination:?}/manifest.json"
    ;;
  *) exit 2 ;;
esac
BASH
cat > "${work}/bin/aws" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
[ "$1" = s3api ] || exit 2
operation=$2; shift 2
key= body= destination= range=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --key) key=$2; shift 2 ;;
    --body) body=$2; shift 2 ;;
    --range) range=$2; shift 2 ;;
    --endpoint-url|--bucket|--content-type|--cache-control|--output|--cli-connect-timeout|--cli-read-timeout) shift 2 ;;
    --*) exit 2 ;;
    *) destination=$1; shift ;;
  esac
done
printf '%s %s\n' "$operation" "$key" >> "$AWS_LOG"
object="${AWS_STORE}/${key}"
case "$operation" in
  head-object) [ -f "$object" ]; printf '{"ContentLength":%s}\n' "$(stat -c '%s' "$object")" ;;
  get-object)
    if [ -n "${GET_BLOCK_FILE:-}" ]; then
      echo "$$" > "$GET_BLOCK_FILE"
      exec sleep 60
    fi
    if [ "${AWS_FAIL:-}" = get ]; then
      echo '{"Error":{"Code":"AccessDenied","Message":"X-Amz-Signature=fixture-sensitive"}}' >&2
      exit 7
    fi
    [ -f "$object" ] || { echo '{"Error":{"Code":"NoSuchKey"}}' >&2; exit 7; }
    head -c "$((${range#bytes=0-} + 1))" "$object" > "$destination"
    ;;
  put-object)
    if [ "${AWS_FAIL:-}" = put ]; then
      echo 'X-Amz-Signature=fixture-sensitive' >&2
      exit 7
    fi
    mkdir -p "$(dirname "$object")"
    cp "$body" "$object"
    ;;
  *) exit 2 ;;
esac
BASH
cat > "${work}/bin/cargo" <<'BASH'
#!/usr/bin/env bash
printf 'cargo\n' >> "$CARGO_LOG"
BASH
chmod +x "${work}/bin/"*
export PATH="${work}/bin:${PATH}" GH_LOG="${work}/gh.log" AWS_LOG="${work}/aws.log"
export CARGO_LOG="${work}/cargo.log" AWS_STORE="${work}/store"
export AWS_ACCESS_KEY_ID=fixture-access AWS_SECRET_ACCESS_KEY=fixture-secret
export R2_ACCOUNT_ID=fixture-account R2_BUCKET_NAME=fixture-bucket
export REPO=okou-ai/okou CURRENT_RUN_ID=100 GITHUB_OUTPUT=''
export INDEX_MANIFEST="${work}/index.json"
: > "$CARGO_LOG"

# Assert the actual workflow condition controlling the compiler, not a private
# reimplementation of cache resolution. Cargo itself is a closed fixture stub.
condition=$(yq -r '.jobs.compile.steps[] | select(.id == "build") | .if' \
  "${REPO_ROOT}/.github/workflows/runner-image.yml")
[ "$condition" = "steps.cache-recheck.outputs.reused != 'true'" ] || fail "unexpected compiler condition"
compiler_boundary() {
  local destination=$1
  OUTPUT_DIR="$destination" "$RECHECK" > "${work}/recheck.log" 2>&1
  local reused
  reused=$(awk -F= '$1 == "reused" {print $2}' "${work}/recheck.log")
  case "$reused" in
    true) ;;
    false) cargo build ;;
    *) fail "unusable recheck result" ;;
  esac
}
expect_failure() {
  local destination=$1
  shift
  if OUTPUT_DIR="$destination" "$@" > "${work}/failure.log" 2>&1; then
    fail "expected failure: ${destination}"
  fi
  [ ! -e "$destination" ] || fail "failed operation exposed output"
  ! grep -q fixture-sensitive "${work}/failure.log" || fail "signed diagnostics leaked"
}

for target in aarch64-unknown-linux-musl x86_64-unknown-linux-musl; do
  export EXPECTED_TARGET=$target
  export EXPECTED_BINARY_INPUT_DIGEST
  EXPECTED_BINARY_INPUT_DIGEST=$("${SCRIPT_DIR}/runner-binary-build/digest.sh" "$target" | \
    awk -F= '$1 == "binary-input-digest" {print $2}')
  export ARTIFACT="runner-binary-asset-${target}-${EXPECTED_BINARY_INPUT_DIGEST}"
  printf 'cached bytes for %s\n' "$target" > "${work}/runner"
  sha=$(sha256sum "${work}/runner" | cut -d' ' -f1)
  object_key="runner-binaries/${target}/${sha}.zst"
  mkdir -p "${AWS_STORE}/runner-binaries/${target}"
  zstd -q -c "${work}/runner" > "${AWS_STORE}/${object_key}"
  jq -n --arg target "$target" --arg digest "$EXPECTED_BINARY_INPUT_DIGEST" \
    --arg toolchain "$RUNNER_BINARY_TOOLCHAIN_IMAGE" --argjson guests "$guests" \
    --arg key "$object_key" '{schemaVersion:1,target:$target,binaryInputDigest:$digest,
      toolchainImage:$toolchain,guests:$guests,object:{key:$key}}' > "$INDEX_MANIFEST"

  # Prepare really misses; only the index availability changes before recheck.
  export RUNNER_HOST_GROUPS_MATRIX
  RUNNER_HOST_GROUPS_MATRIX=$(jq -cn --arg target "$target" '[{
    id:"fixture",label:"fixture",target:$target,unameM:"fixture",
    cacheSuffix:"fixture",assetSuffix:"fixture"
  }]')
  GH_MODE=miss RESOLVE_OUTPUT_DIR="${work}/prepare-${target}" \
    "${SCRIPT_DIR}/runner-binary-cache-plan.sh" > "${work}/prepare.log"
  grep -qx miss-count=1 "${work}/prepare.log" || fail "prepare did not select compilation"
  compiler_boundary "${work}/late-${target}"
  [ ! -s "$CARGO_LOG" ] || fail "late matching reference invoked Cargo"
  grep -qx reused=true "${work}/recheck.log" || fail "late hit not reported"
  export RUNNER_PATH="${work}/late-${target}/runner"
  export FRESH_METADATA_PATH="${work}/late-${target}/metadata.json"
  export CACHED_REFERENCE_PATH="${work}/late-${target}/cached-reference.json"
  cmp "${work}/runner" "$RUNNER_PATH"
  : > "$AWS_LOG"
  OUTPUT_DIR="${work}/published-${target}" "$TRANSPORT" publish-cached > "${work}/publish.log"
  grep -qx binary-source=cached "${work}/publish.log" || fail "cached publication mislabeled"
  [ "$(wc -l < "$AWS_LOG")" = 1 ] || fail "cached publication must not republish binary bytes"
  ready="${AWS_STORE}/runner-binaries/transports/100/${EXPECTED_BINARY_INPUT_DIGEST}.json"
  jq -e --arg sha "$sha" '.kind == "cached" and .runId == 100 and .cacheIndexRunId == 11 and
    .metadata.runnerSha256 == $sha and (has("producer") | not)' "$ready" >/dev/null
  GITHUB_RUN_ATTEMPT=9 OUTPUT_DIR="${work}/consumer-${target}" "$TRANSPORT" download > "${work}/consumer.log" 2>&1
  grep -qx binary-source=cached "${work}/consumer.log" || fail "cached consumer mislabeled"
  cmp "$RUNNER_PATH" "${work}/consumer-${target}/runner"
  [ ! -e "${work}/consumer-${target}/manifest.json" ] || fail "cached bytes minted a fresh producer index"
done

# Real misses and bounded optional lookup failures retain compilation.
for mode in miss unavailable; do
  GH_MODE="$mode" compiler_boundary "${work}/fallback-${mode}"
  [ ! -e "${work}/fallback-${mode}" ] || fail "a miss exposed cached bytes"
done
for mode in deadline kill-deadline; do
  LOOKUP_MODE="$mode" compiler_boundary "${work}/fallback-${mode}"
  grep -qx resolve-reason=resolve-timeout "${work}/recheck.log" || fail "timeout not explicit"
done
: > "$GH_LOG"
RUNNER_BINARY_CACHE_FORCE_MISS=true compiler_boundary "${work}/forced"
[ ! -s "$GH_LOG" ] || fail "forced miss contacted GitHub"
EXPIRED=true compiler_boundary "${work}/expired"
[ "$(wc -l < "$CARGO_LOG")" = 6 ] || fail "misses must invoke Cargo exactly once each"

cp "$INDEX_MANIFEST" "${work}/valid-index.json"
for change in '.target = "aarch64-unknown-linux-musl"' '.binaryInputDigest = ("b" * 64)' \
  '.toolchainImage = "another/toolchain"' '.guests = {}' '.guests["guest-agent"] = "invalid"'; do
  jq "$change" "${work}/valid-index.json" > "$INDEX_MANIFEST"
  compiler_boundary "${work}/mismatched"
  [ ! -e "${work}/mismatched" ] || fail "mismatched input shared work"
done
cp "${work}/valid-index.json" "$INDEX_MANIFEST"
for mode in cancelled malformed incomplete; do
  LOOKUP_MODE="$mode" expect_failure "${work}/bad-${mode}" "$RECHECK"
done
RUNNER_BINARY_CACHE_FORCE_MISS=invalid expect_failure "${work}/bad-config" "$RECHECK"
AWS_FAIL='get' expect_failure "${work}/bad-get" "$RECHECK"
cp "${AWS_STORE}/${object_key}" "${work}/valid.zst"
printf 'corrupt\n' > "${AWS_STORE}/${object_key}"
expect_failure "${work}/corrupt" "$RECHECK"
cp "${work}/valid.zst" "${AWS_STORE}/${object_key}"

# A captured local-byte identity, not a GitHub SHA hint, governs the rerun.
cp "$ready" "${work}/valid-ready.json"
printf 'different valid runner bytes\n' | zstd -q -c > "${AWS_STORE}/${object_key}"
expect_failure "${work}/changed-bytes" "$TRANSPORT" download
cp "${work}/valid.zst" "${AWS_STORE}/${object_key}"
for change in '.runId = 999' '.repository = "other/repo"' '.kind = "unknown"' \
  '.metadata.runnerSha256 = ("b" * 64)' '.reference.toolchainImage = "wrong"' \
  '.reference.guestSha256 = {}' '.cacheIndexRunId = 1.5' '.extra = true'; do
  jq "$change" "${work}/valid-ready.json" > "$ready"
  expect_failure "${work}/bad-receipt" "$TRANSPORT" download
done
cp "${work}/valid-ready.json" "$ready"
CURRENT_RUN_ID=101 expect_failure "${work}/cross-run" "$TRANSPORT" download
# Independent submissions publish only their own namespace, concurrently.
for run in 101 102; do
  jq --argjson run "$run" '.runId = $run' "${work}/valid-ready.json" > "${work}/receipt-${run}.json"
  CURRENT_RUN_ID="$run" CACHED_REFERENCE_PATH="${work}/receipt-${run}.json" \
    OUTPUT_DIR="${work}/publish-${run}" "$TRANSPORT" publish-cached >/dev/null &
  if [ "$run" = 101 ]; then first=$!; else second=$!; fi
done
wait "$first"
wait "$second"
for run in 101 102; do
  CURRENT_RUN_ID="$run" OUTPUT_DIR="${work}/read-${run}" "$TRANSPORT" download >/dev/null 2>&1
  cmp "$RUNNER_PATH" "${work}/read-${run}/runner"
done
jq '.runId = 200' "${work}/valid-ready.json" > "${work}/receipt-200.json"
AWS_FAIL=put CURRENT_RUN_ID=200 CACHED_REFERENCE_PATH="${work}/receipt-200.json" \
  expect_failure "${work}/bad-put" "$TRANSPORT" publish-cached
[ ! -e "${AWS_STORE}/runner-binaries/transports/200/${EXPECTED_BINARY_INPUT_DIGEST}.json" ] || fail "failed publication advertised readiness"

[ "$(wc -l < "$CARGO_LOG")" = 11 ] || fail "failed selected hits invoked Cargo"

# Cancellation kills owned lookup / required transfer workers, never falls back
# to successful readiness, and removes unexposed scratch/output state.
for stage in lookup download; do
  block="${work}/block-${stage}"
  destination="${work}/cancel-${stage}"
  if [ "$stage" = lookup ]; then
    GH_MODE=block BLOCK_FILE="$block" OUTPUT_DIR="$destination" "$RECHECK" > "${work}/cancel.log" 2>&1 &
  else
    GET_BLOCK_FILE="$block" OUTPUT_DIR="$destination" "$RECHECK" > "${work}/cancel.log" 2>&1 &
  fi
  pid=$!
  for ((attempt=0; attempt<200; attempt++)); do
    [ ! -f "$block" ] || break
    sleep .05
  done
  [ -f "$block" ] || { kill -TERM "$pid"; fail "worker did not enter ${stage}"; }
  worker=$(<"$block")
  kill -TERM "$pid"
  status=0
  wait "$pid" || status=$?
  [ "$status" = 143 ] || fail "cancellation became success: ${status}"
  [ ! -e "$destination" ] || fail "cancelled recheck exposed output"
  for ((attempt=0; attempt<100; attempt++)); do
    if ! kill -0 "$worker" 2>/dev/null; then break; fi
    # An exited orphan may await reaping by the test host's init.
    state=$(ps -o stat= -p "$worker" || true)
    [[ "$state" != Z* ]] || break
    sleep .02
  done
  state=$(ps -o stat= -p "$worker" || true)
  [[ -z "$state" || "$state" = Z* ]] || fail "cancelled ${stage} worker remains live"
done

[ -z "$(find "$work" -maxdepth 1 -name 'runner-binary-recheck.*' -print -quit)" ] || fail "recheck leaked scratch state"
echo "runner-binary-cache-recheck-test: ok"
