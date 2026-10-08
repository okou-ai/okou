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
if [[ " $* " == *' --paginate '* && " $* " == *' --slurp '* ]]; then
  cat "$MOCK_RESPONSE"
else
  jq '.[0:1]' "$MOCK_RESPONSE"
fi
SH
cat >"${test_root}/bin/sleep" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "${test_root}/bin/gh" "${test_root}/bin/sleep"

response() {
  jq -cn --argjson count "$1" --argjson entry "${2:-null}" \
    --argjson author_count "${3:-1}" --arg author "${4:-developer}" '
    [range($count) | {number: (. + 42), author: {login: (if . < $author_count then $author else "other-author" end)}}] as $nodes |
    [range(0; ([1, $count] | max); 100) as $start |
      {data: {repository: {
        pullRequests: {
          totalCount: $count,
          nodes: $nodes[$start:($start + 100)],
          pageInfo: {hasNextPage: ($start + 100 < $count), endCursor: "cursor-\($start + 100)"}
        },
        pullRequest: {number: 42, author: {login: $author}, mergeQueueEntry: $entry}
      }}}
    ]
  ' >"${test_root}/response.json"
}

run_admission() {
  local event=${1:-pull_request} failures=${2:-0}
  local limit=${3-40} author_limit=${4-20}
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
      CI_MAX_OPEN_PRS="$limit" \
      CI_MAX_OPEN_PRS_PER_AUTHOR="$author_limit" \
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
assert_contains "$output" 'fewer than 40'
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

# The current PR is included in its author's count: 20 is allowed, 21 is not.
response 30 null 20
run_admission
[[ "$status" == 0 ]] || fail "an author with 20 open PRs should be admitted: $output"
response 30 null 21
run_admission
[[ "$status" == 1 ]] || fail "an author with 21 open PRs should fail"
assert_contains "$output" 'CI_AUTHOR_PR_LIMIT'
assert_contains "$output" 'Author developer has 21 open PRs in test/repo'
assert_contains "$summary" 'Author **developer**: **21 open PRs**'
assert_contains "$summary" 'at most 20 open PRs'
assert_contains "$summary" 'repos/test/repo/pulls?state=open&per_page=100'
[[ "$output" != *CI_CAPACITY_LIMIT* ]] || fail "author limit must apply below the repository limit"

# Bot and draft PRs are counted by the same open-PR query, without exemptions.
response 30 null 21 'dependabot[bot]'
run_admission
[[ "$status" == 1 ]] || fail "bot authors should have the same limit"
assert_contains "$output" 'Author dependabot[bot] has 21 open PRs'

response 39 null 20
run_admission
[[ "$status" == 0 ]] || fail "a retry after both limits recover should pass: $output"

# Custom repository/author limits govern admission and the recovery instructions.
response 50 null 50
run_admission pull_request 0 50 50
[[ "$status" == 0 ]] || fail "the initial 50/50 configuration should admit exactly 50 PRs: $output"
response 51 null 51
run_admission pull_request 0 50 50
[[ "$status" == 1 ]] || fail "the initial 50/50 configuration should reject 51 PRs"
assert_contains "$output" 'CI_CAPACITY_LIMIT'
assert_contains "$output" 'CI_AUTHOR_PR_LIMIT'
assert_contains "$summary" 'fewer than 50 open PRs'
assert_contains "$summary" 'at most 50 open PRs'

response 12 null 6
run_admission pull_request 0 12 6
[[ "$status" == 0 ]] || fail "configured limits should allow their exact boundaries: $output"
response 13 null 7
run_admission pull_request 0 12 6
[[ "$status" == 1 ]] || fail "both configured limits should reject excess PRs"
assert_contains "$output" '13 open PRs (limit: 12)'
assert_contains "$output" '7 open PRs in test/repo (limit: 6)'
assert_contains "$summary" 'fewer than 12 open PRs'
assert_contains "$summary" 'at most 6 open PRs'
response 11 null 6
run_admission pull_request 0 12 6
[[ "$status" == 0 ]] || fail "a retry below configured limits should recover: $output"

# A zero limit explicitly pauses unqueued admission; invalid config fails closed.
response 1
run_admission pull_request 0 0 20
[[ "$status" == 1 ]] || fail "zero repository capacity should pause unqueued PRs"
assert_contains "$output" 'CI_CAPACITY_LIMIT'
run_admission pull_request 0 40 0
[[ "$status" == 1 ]] || fail "zero author capacity should pause unqueued PRs"
assert_contains "$output" 'CI_AUTHOR_PR_LIMIT'
for invalid in '' '-1' '1.5' '01' 'bad' '2147483648' '99999999999999999999' '1+1'; do
  for variable in CI_MAX_OPEN_PRS CI_MAX_OPEN_PRS_PER_AUTHOR; do
    if [[ "$variable" == CI_MAX_OPEN_PRS ]]; then
      run_admission pull_request 0 "$invalid" 20
    else
      run_admission pull_request 0 40 "$invalid"
    fi
    [[ "$status" == 1 ]] || fail "invalid $variable should fail closed"
    assert_contains "$output" 'CI_ADMISSION_CONFIG_INVALID'
    assert_contains "$summary" "$variable must be an integer"
    assert_contains "$summary" 'settings/variables/actions'
  done
done

# Count every page and report both limits when both are exceeded.
response 101 null 21
jq '
  .[0].data.repository.pullRequests.nodes[0] as $author_pr |
  .[1].data.repository.pullRequests.nodes[0] as $other_pr |
  .[0].data.repository.pullRequests.nodes[0] = $other_pr |
  .[1].data.repository.pullRequests.nodes[0] = $author_pr
' "${test_root}/response.json" >"${test_root}/paginated.json"
mv "${test_root}/paginated.json" "${test_root}/response.json"
run_admission
[[ "$status" == 1 ]] || fail "both exceeded limits should fail"
assert_contains "$output" 'CI_CAPACITY_LIMIT'
assert_contains "$output" 'CI_AUTHOR_PR_LIMIT'
assert_contains "$summary" '**101 open PRs**'
assert_contains "$summary" '**21 open PRs**'

# Actual queue membership exempts PR-triggered runs at any count.
response 60 '{"id":"queue-entry"}' 30
run_admission
[[ "$status" == 0 ]] || fail "queued PRs should be admitted: $output"
assert_contains "$output" 'in merge queue: true'
run_admission pull_request 0 '' ''
[[ "$status" == 0 ]] || fail "queued PRs must proceed without admission configuration"

# Merge groups and staging must proceed even when GitHub lookups fail.
for event in merge_group push; do
  run_admission "$event" 3 '' ''
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
  '.[0].errors = [{message: "forbidden"}]' \
  '.[0].data.repository = null' \
  'del(.[0].data.repository.pullRequest.mergeQueueEntry)' \
  '.[0].data.repository.pullRequest.mergeQueueEntry = {}' \
  '.[0].data.repository.pullRequest.author = null' \
  '.[0].data.repository.pullRequests.nodes = []'; do
  response 39
  jq "$invalid" "${test_root}/response.json" >"${test_root}/invalid.json"
  mv "${test_root}/invalid.json" "${test_root}/response.json"
  run_admission
  [[ "$status" == 1 ]] || fail "invalid GitHub response must fail closed"
  assert_contains "$output" 'CI_ADMISSION_QUERY_FAILED'
done

echo "check-pr-ci-capacity-test: ok"
