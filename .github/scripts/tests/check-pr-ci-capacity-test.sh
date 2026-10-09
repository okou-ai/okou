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
  mock_pr_number=${5:-42}
  jq -cn --argjson count "$1" --argjson entry "${2:-null}" \
    --argjson author_count "${3:-1}" --arg author "${4:-developer}" \
    --argjson number "$mock_pr_number" '
    [range($count) | {
      number: (. + 42),
      author: {login: (if . < $author_count then $author else "other-author" end)}
    }] as $nodes |
    [range(0; ([1, $count] | max); 100) as $start |
      {data: {repository: {
        pullRequests: {
          totalCount: $count,
          nodes: $nodes[$start:($start + 100)],
          pageInfo: {hasNextPage: ($start + 100 < $count), endCursor: "cursor-\($start + 100)"}
        },
        pullRequest: {number: $number, author: {login: $author}, mergeQueueEntry: $entry}
      }}}
    ]
  ' >"${test_root}/response.json"
}

run_admission() {
  local event=${1:-pull_request} failures=${2:-0}
  local limit=${3-40} author_limit=${4-20}
  local bypass_list=${5-}
  printf '0\n' >"${test_root}/attempts"
  : >"${test_root}/summary.md"
  status=0
  output=$(
    PATH="${test_root}/bin:$PATH" \
      EVENT_NAME="$event" \
      GH_TOKEN=test-token \
      GITHUB_REPOSITORY=test/repo \
      PR_NUMBER="$mock_pr_number" \
      GITHUB_RUN_ID=123 \
      CI_MAX_OPEN_PRS="$limit" \
      CI_MAX_OPEN_PRS_PER_AUTHOR="$author_limit" \
      CI_PR_ADMISSION_BYPASS_LIST="$bypass_list" \
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
assert_contains "$output" 'at most 40'
[[ "$output" != *CI_AUTHOR_PR_LIMIT* ]] || fail "repository capacity must still apply to an author's lowest-numbered PR"
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

# Fixtures omit timestamps; admission uses the author's lowest PR numbers.
response 30 null 21
run_admission
[[ "$status" == 0 ]] || fail "an author's lowest-numbered PR should pass above the author count limit: $output"
assert_contains "$output" 'author position (lowest PR number first): 1'
response 30 null 21 developer 61
run_admission
[[ "$status" == 0 ]] || fail "the author's 20th lowest-numbered PR should be admitted: $output"
assert_contains "$output" 'author position (lowest PR number first): 20'
response 30 null 21 developer 62
run_admission
[[ "$status" == 1 ]] || fail "the author's 21st lowest-numbered PR should fail"
assert_contains "$output" 'CI_AUTHOR_PR_LIMIT'
assert_contains "$output" 'position 21 by PR number among 21 open PRs by developer'
assert_contains "$summary" 'Author **developer**: **21 open PRs**'
assert_contains "$summary" 'PR-number position **21**'
assert_contains "$summary" "among the author's 20 lowest-numbered open PRs"
assert_contains "$summary" 'repos/test/repo/pulls?state=open&per_page=100'
assert_contains "$summary" 'sort_by(.number)'
[[ "$output" != *CI_CAPACITY_LIMIT* ]] || fail "author limit must apply below the repository limit"

# Re-running all 11 unqueued PRs admits the first 10, not none of them.
for number in {42..52}; do
  response 11 null 11 developer "$number"
  run_admission pull_request 0 40 10
  if ((number < 52)); then
    [[ "$status" == 0 ]] || fail "PR #$number should be among the author's 10 lowest numbers: $output"
  else
    [[ "$status" == 1 ]] || fail "only the 11th PR should exceed the author limit"
    assert_contains "$output" 'position 11 by PR number among 11 open PRs'
  fi
done

# Closing a lower-numbered PR promotes the same blocked PR on a later retry.
jq '
  .[0].data.repository.pullRequests.nodes |= map(select(.number != 42)) |
  .[0].data.repository.pullRequests.totalCount = 10
' "${test_root}/response.json" >"${test_root}/closed.json"
mv "${test_root}/closed.json" "${test_root}/response.json"
run_admission pull_request 0 40 10
[[ "$status" == 0 ]] || fail "closing a lower-numbered PR should free an author slot: $output"
assert_contains "$output" 'PR #52 author position (lowest PR number first): 10'

# PR-number priority is independent of the order of returned nodes.
for number in 51 52; do
  response 11 null 11 developer "$number"
  jq '.[0].data.repository.pullRequests.nodes |= reverse' \
    "${test_root}/response.json" >"${test_root}/reordered.json"
  mv "${test_root}/reordered.json" "${test_root}/response.json"
  run_admission pull_request 0 40 10
  if [[ "$number" == 51 ]]; then
    [[ "$status" == 0 ]] || fail "the 10th lowest number should pass with reversed nodes: $output"
  else
    [[ "$status" == 1 ]] || fail "the 11th lowest number should fail with reversed nodes"
  fi
done

# Numbers have gaps and cross digit boundaries; rank is not the number itself.
for number in 2 100 101; do
  response 11 null 11 developer "$number"
  jq '
    [2, 10, 11, 12, 13, 14, 15, 16, 17, 100, 101] as $numbers |
    .[0].data.repository.pullRequests.nodes |=
      (to_entries | map(.value.number = $numbers[.key] | .value) | reverse)
  ' "${test_root}/response.json" >"${test_root}/gapped.json"
  mv "${test_root}/gapped.json" "${test_root}/response.json"
  run_admission pull_request 0 40 10
  if [[ "$number" == 101 ]]; then
    [[ "$status" == 1 ]] || fail "the 11th gapped number should fail"
    assert_contains "$output" 'position 11 by PR number'
  else
    [[ "$status" == 0 ]] || fail "a low-ranked PR should pass despite its gapped number: $output"
  fi
done

# Other authors do not consume slots, even if their PR numbers are lower.
response 35 null 11 developer 51
jq '.[0].data.repository.pullRequests.nodes |= map(
  if .author.login == "other-author" then .number -= 52 else . end
)' "${test_root}/response.json" >"${test_root}/other-author.json"
mv "${test_root}/other-author.json" "${test_root}/response.json"
run_admission pull_request 0 40 10
[[ "$status" == 0 ]] || fail "other authors' lower PR numbers must not consume author slots: $output"
assert_contains "$output" 'PR #51 author position (lowest PR number first): 10'

# Bot and draft PRs are counted by the same open-PR query, without exemptions.
response 30 null 21 'dependabot[bot]' 62
run_admission
[[ "$status" == 1 ]] || fail "bot authors should have the same limit"
assert_contains "$output" '21 open PRs by dependabot[bot]'
response 11 null 11 developer 52
jq '.[0].data.repository.pullRequests.nodes[0].isDraft = true' \
  "${test_root}/response.json" >"${test_root}/draft.json"
mv "${test_root}/draft.json" "${test_root}/response.json"
run_admission pull_request 0 40 10
[[ "$status" == 1 ]] || fail "lower-numbered drafts must still consume author slots"

response 39 null 20 developer 61
run_admission
[[ "$status" == 0 ]] || fail "a retry after both limits recover should pass: $output"

# Custom repository/author limits govern admission and the recovery instructions.
response 50 null 50 developer 91
run_admission pull_request 0 50 50
[[ "$status" == 0 ]] || fail "the initial 50/50 configuration should admit exactly 50 PRs: $output"
response 51 null 51 developer 92
run_admission pull_request 0 50 50
[[ "$status" == 1 ]] || fail "the initial 50/50 configuration should reject the 51st PR"
assert_contains "$output" 'CI_CAPACITY_LIMIT'
assert_contains "$output" 'CI_AUTHOR_PR_LIMIT'
assert_contains "$summary" 'at most 50 open PRs'
assert_contains "$summary" "among the author's 50 lowest-numbered open PRs"

response 12 null 6 developer 47
run_admission pull_request 0 12 6
[[ "$status" == 0 ]] || fail "configured limits should allow their exact boundaries: $output"
response 13 null 7 developer 48
run_admission pull_request 0 12 6
[[ "$status" == 1 ]] || fail "both configured limits should reject excess PRs"
assert_contains "$output" '13 open PRs (limit: 12)'
assert_contains "$output" 'position 7 by PR number among 7 open PRs'
assert_contains "$summary" 'at most 12 open PRs'
assert_contains "$summary" "among the author's 6 lowest-numbered open PRs"
response 11 null 6 developer 47
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

# Only exact PR numbers bypass both limits; the normal workflow still runs.
response 60 null 30 developer 62
run_admission pull_request 0 40 20 '62'
[[ "$status" == 0 ]] || fail "a listed PR should bypass both limits: $output"
assert_contains "$output" 'CI_PR_ADMISSION_BYPASS'
assert_contains "$output" 'PR #62 is listed in CI_PR_ADMISSION_BYPASS_LIST'
assert_contains "$summary" 'Normal CI and required checks still run'
assert_contains "$summary" '**60** (limit: **40**)'
assert_contains "$summary" '**30 open PRs** (limit: **20**)'
run_admission pull_request 0 40 20 $' 99,\n 62 ,100 '
[[ "$status" == 0 ]] || fail "a PR within a whitespace-trimmed list should bypass limits: $output"
run_admission pull_request 0 0 0 '62,62'
[[ "$status" == 0 ]] || fail "a listed PR should bypass zero count limits: $output"

for bypass_list in '' '  ' '162,620'; do
  run_admission pull_request 0 40 20 "$bypass_list"
  [[ "$status" == 1 ]] || fail "empty or unrelated bypass lists must not grant admission"
  assert_contains "$output" 'CI_CAPACITY_LIMIT'
  assert_contains "$output" 'CI_AUTHOR_PR_LIMIT'
  [[ "$output" != *CI_PR_ADMISSION_BYPASS:* ]] || fail "bypass matching must be exact"
done

# Invalid configuration or unavailable GitHub state cannot be bypassed.
for invalid in '42,' ',42' '42,,43' '0' '-42' '042' '42.0' '4 2' '*' '[42]' '#42' '2147483648' '99999999999999999999' '42,bad'; do
  run_admission pull_request 0 40 20 "$invalid"
  [[ "$status" == 1 ]] || fail "invalid bypass list must fail closed: $invalid"
  assert_contains "$output" 'CI_ADMISSION_CONFIG_INVALID'
  assert_contains "$summary" 'CI_PR_ADMISSION_BYPASS_LIST must be empty or contain comma-separated PR numbers'
done
run_admission pull_request 0 '' 20 '62'
[[ "$status" == 1 ]] || fail "bypass must not hide missing repository limit configuration"
assert_contains "$output" 'CI_ADMISSION_CONFIG_INVALID'
run_admission pull_request 0 40 bad '62'
[[ "$status" == 1 ]] || fail "bypass must not hide invalid author limit configuration"
assert_contains "$output" 'CI_ADMISSION_CONFIG_INVALID'
run_admission pull_request 3 40 20 '62'
[[ "$status" == 1 ]] || fail "bypass must not hide a GitHub query failure"
assert_contains "$output" 'CI_ADMISSION_QUERY_FAILED'

# Numeric ranking spans every page, not the current page or array order.
response 101 null 21
jq '
  .[0].data.repository.pullRequests.nodes[0] as $author_pr |
  .[1].data.repository.pullRequests.nodes[0] as $other_pr |
  .[0].data.repository.pullRequests.nodes[0] = $other_pr |
  .[1].data.repository.pullRequests.nodes[0] = $author_pr
' "${test_root}/response.json" >"${test_root}/paginated.json"
mv "${test_root}/paginated.json" "${test_root}/response.json"
run_admission pull_request 0 101 20
[[ "$status" == 0 ]] || fail "the lowest PR number on the last page should be admitted: $output"
assert_contains "$output" 'PR #42 author position (lowest PR number first): 1'

response 101 null 21 developer 62
run_admission pull_request 0 101 20
[[ "$status" == 1 ]] || fail "the author's 21st PR must fail even with repository capacity"
assert_contains "$output" 'CI_AUTHOR_PR_LIMIT'
[[ "$output" != *CI_CAPACITY_LIMIT* ]] || fail "repository capacity should allow its exact boundary"
run_admission
[[ "$status" == 1 ]] || fail "both exceeded limits should fail"
assert_contains "$output" 'CI_CAPACITY_LIMIT'
assert_contains "$output" 'CI_AUTHOR_PR_LIMIT'
assert_contains "$summary" '**101 open PRs**'
assert_contains "$summary" '**21 open PRs**'

# Actual queue membership exempts PR-triggered runs at any count or position.
response 60 '{"id":"queue-entry"}' 30 developer 62
run_admission
[[ "$status" == 0 ]] || fail "queued PRs should be admitted: $output"
assert_contains "$output" 'in merge queue: true'
run_admission pull_request 0 '' '' 'bad'
[[ "$status" == 0 ]] || fail "queued PRs must proceed without admission configuration"

# Merge groups and staging must proceed even when GitHub lookups fail.
for event in merge_group push; do
  run_admission "$event" 3 '' '' 'bad'
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
  '.[0].data.repository.pullRequests.nodes = []' \
  '.[0].data.repository.pullRequests.nodes[0].number = "42"' \
  '.[0].data.repository.pullRequests.nodes[1].number = 42' \
  '.[0].data.repository.pullRequests.nodes[0].number = 500' \
  '.[0].data.repository.pullRequests.nodes[0].author.login = "different-author"'; do
  response 39
  jq "$invalid" "${test_root}/response.json" >"${test_root}/invalid.json"
  mv "${test_root}/invalid.json" "${test_root}/response.json"
  run_admission
  [[ "$status" == 1 ]] || fail "invalid GitHub response must fail closed"
  assert_contains "$output" 'CI_ADMISSION_QUERY_FAILED'
done

# Unrelated PRs from deleted authors still consume repository capacity only.
response 11 null 10 developer 51
jq '.[0].data.repository.pullRequests.nodes[10].author = null' \
  "${test_root}/response.json" >"${test_root}/deleted-author.json"
mv "${test_root}/deleted-author.json" "${test_root}/response.json"
run_admission pull_request 0 40 10
[[ "$status" == 0 ]] || fail "unrelated deleted authors must not prevent author ranking: $output"

echo "check-pr-ci-capacity-test: ok"
