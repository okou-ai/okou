#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
script="${repo_root}/.github/scripts/check-pr-ci-capacity.sh"
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT
mkdir -p "${test_root}/bin"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_contains() {
  [[ "$1" == *"$2"* ]] || fail "expected output to contain: $2"
}

cat >"${test_root}/bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1 $2" == 'api graphql' ]] || exit 2
attempt=$(cat "$MOCK_ATTEMPTS")
attempt=$((attempt + 1))
printf '%s\n' "$attempt" >"$MOCK_ATTEMPTS"
if ((attempt <= MOCK_FAILURES)); then
  echo 'gh: GitHub API unavailable (HTTP 503)' >&2
  exit 1
fi
cat "$MOCK_RESPONSE"
SH
cat >"${test_root}/bin/sleep" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "${test_root}/bin/gh" "${test_root}/bin/sleep"

response() {
  jq -cn --argjson count "$1" --argjson entry "${2:-null}" '
    {data: {repository: {
      pullRequests: {totalCount: $count},
      pullRequest: {number: 42, mergeQueueEntry: $entry}
    }}}
  ' >"${test_root}/response.json"
}

run_admission() {
  local event=${1:-pull_request} failures=${2:-0}
  printf '0\n' >"${test_root}/attempts"
  : >"${test_root}/summary.md"
  status=0
  output=$(
    PATH="${test_root}/bin:$PATH" \
      EVENT_NAME="$event" \
      GH_TOKEN=test-token \
      GITHUB_REPOSITORY=test/repo \
      PR_NUMBER=42 \
      GITHUB_RUN_ID=123 \
      GITHUB_STEP_SUMMARY="${test_root}/summary.md" \
      MOCK_ATTEMPTS="${test_root}/attempts" \
      MOCK_RESPONSE="${test_root}/response.json" \
      MOCK_FAILURES="$failures" \
      bash "$script" 2>&1
  ) || status=$?
  summary=$(cat "${test_root}/summary.md")
}

# The threshold is strictly greater than 40, counting all open PRs.
response 40
run_admission
[[ "$status" == 0 ]] || fail "40 open PRs should be admitted: $output"
assert_contains "$output" 'Open PRs: 40'

response 41
run_admission
[[ "$status" == 1 ]] || fail "an unqueued PR at 41 open PRs should fail"
assert_contains "$output" 'CI_CAPACITY_LIMIT'
assert_contains "$output" '41 open PRs'
assert_contains "$output" 'below 40'
assert_contains "$output" 'gh run rerun 123 --repo test/repo'
assert_contains "$summary" '**41 open PRs**'
assert_contains "$summary" 'not in the merge queue'
assert_contains "$summary" 'not a code or test failure'
assert_contains "$summary" 'pullRequests(states: OPEN)'
assert_contains "$summary" 'gh run rerun 123 --repo test/repo'

# A later retry of the same run must read the new count and recover.
response 39
run_admission
[[ "$status" == 0 ]] || fail "a retry after capacity recovers should pass: $output"

# Actual queue membership exempts PR-triggered runs at any count.
response 60 '{"id":"queue-entry"}'
run_admission
[[ "$status" == 0 ]] || fail "queued PRs should be admitted: $output"
assert_contains "$output" 'in merge queue: true'

# Merge groups and staging must proceed even when GitHub lookups fail.
for event in merge_group push; do
  run_admission "$event" 3
  [[ "$status" == 0 ]] || fail "$event should be admitted: $output"
  [[ "$(cat "${test_root}/attempts")" == 0 ]] || fail "$event should not query PR admission"
done

response 39
run_admission pull_request 1
[[ "$status" == 0 ]] || fail "a transient GitHub failure should recover: $output"
[[ "$(cat "${test_root}/attempts")" == 2 ]] || fail "transient failure should be retried"

run_admission pull_request 3
[[ "$status" == 1 ]] || fail "unknown admission state must fail closed"
assert_contains "$output" 'CI_ADMISSION_QUERY_FAILED'
assert_contains "$summary" 'gh run rerun 123 --repo test/repo'
[[ "$(cat "${test_root}/attempts")" == 3 ]] || fail "GitHub retries must be bounded"
[[ "$output" != *CI_CAPACITY_LIMIT* ]] || fail "API failure must not be reported as capacity exhaustion"

# Partial GraphQL errors and missing queue/count data must not grant admission.
for invalid in \
  '{"errors":[{"message":"forbidden"}],"data":{"repository":{"pullRequests":{"totalCount":0},"pullRequest":{"number":42,"mergeQueueEntry":null}}}}' \
  '{"data":{"repository":null}}' \
  '{"data":{"repository":{"pullRequests":{"totalCount":0},"pullRequest":{"number":42}}}}' \
  '{"data":{"repository":{"pullRequests":{"totalCount":41},"pullRequest":{"number":42,"mergeQueueEntry":{}}}}'; do
  printf '%s\n' "$invalid" >"${test_root}/response.json"
  run_admission
  [[ "$status" == 1 ]] || fail "invalid GitHub response must fail closed"
  assert_contains "$output" 'CI_ADMISSION_QUERY_FAILED'
done

echo "check-pr-ci-capacity-test: ok"
