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
      author: {login: (if . < $author_count then $author else "other-author-\(.)" end)},
      mergeQueueEntry: (if . + 42 == $number then $entry else null end)
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

# Build contiguous author pools while retaining the real paginated API shape.
author_pools() {
  local counts=$1
  response "$(jq 'add' <<<"$counts")" null "$(jq '.[0]' <<<"$counts")" developer "${2:-42}"
  jq --argjson counts "$counts" '
    [range($counts | length) as $author | range($counts[$author]) |
      {login: (if $author == 0 then "developer" else "author-\($author)" end)}
    ] as $authors |
    .[].data.repository.pullRequests.nodes |= map(.author = $authors[.number - 42])
  ' "${test_root}/response.json" >"${test_root}/authors.json"
  mv "${test_root}/authors.json" "${test_root}/response.json"
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

# Each PR here has an author slot; the effective threshold is greater than 40.
response 40
run_admission
[[ "$status" == 0 ]] || fail "40 open PRs should be admitted: $output"
assert_contains "$output" 'Open PRs: 40'

response 41
run_admission
[[ "$status" == 1 ]] || fail "an unqueued PR at 41 effective candidates should fail"
assert_contains "$output" 'CI_CAPACITY_LIMIT'
assert_contains "$output" '41 open PRs'
assert_contains "$output" 'at most 40'
[[ "$output" != *CI_AUTHOR_PR_LIMIT* ]] || fail "repository capacity must still apply to an author's lowest-numbered PR"
assert_contains "$output" 'gh run rerun 123 --repo test/repo'
assert_contains "$summary" '**41 CI candidate PRs**'
assert_contains "$summary" '**41 open PRs**'
assert_contains "$summary" 'not in the merge queue'
assert_contains "$summary" 'not a code or test failure'
assert_contains "$summary" 'pullRequests(states: OPEN)'
assert_contains "$summary" 'not a count of running jobs or live Neon branches'
assert_contains "$summary" 'gh run rerun 123 --repo test/repo'

# A later retry of the same run must read the new count and recover.
response 39
run_admission
[[ "$status" == 0 ]] || fail "a retry after capacity recovers should pass: $output"

# Excess ordinary backlog is capped independently for every author.
author_pools '[30,15]'
run_admission pull_request 0 40 10
[[ "$status" == 0 ]] || fail "45 raw open PRs with 20 candidates should pass: $output"
assert_contains "$output" 'Open PRs: 45; CI candidate PRs: 20'
author_pools '[30,15]' 71
run_admission pull_request 0 40 10
[[ "$status" == 1 ]] || fail "a capped repository pool must not waive the target's author rank"
assert_contains "$output" 'CI_AUTHOR_PR_LIMIT'
[[ "$output" != *CI_CAPACITY_LIMIT* ]] || fail "ordinary backlog must not exhaust global capacity"

# Capped multi-author pools still enforce the exact 40/41 global boundary.
author_pools '[20,10,10,10]'
run_admission pull_request 0 40 10
[[ "$status" == 0 ]] || fail "50 raw PRs with exactly 40 candidates should pass: $output"
assert_contains "$output" 'CI candidate PRs: 40'
author_pools '[20,10,10,10,1]'
run_admission pull_request 0 40 10
[[ "$status" == 1 ]] || fail "41 candidates should fail despite per-author capping"
assert_contains "$output" '41 CI candidate PRs (51 open PRs; limit: 40)'

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

# Numeric slot selection must classify a gapped outside MQ PR correctly.
response 11 null 11 developer 2
jq '
  [2, 10, 11, 12, 13, 14, 15, 16, 17, 100, 101] as $numbers |
  .[0].data.repository.pullRequests.nodes |= (to_entries | map(
    .value.number = $numbers[.key] | .value |
    if .number == 101 then .mergeQueueEntry = {id: "queued-101"} else . end
  ) | reverse)
' "${test_root}/response.json" >"${test_root}/gapped.json"
mv "${test_root}/gapped.json" "${test_root}/response.json"
run_admission pull_request 0 10 10
[[ "$status" == 1 ]] || fail "the numerically 11th queued PR must add an outside candidate"
assert_contains "$output" '11 CI candidate PRs'
[[ "$output" != *CI_AUTHOR_PR_LIMIT* ]] || fail "the lowest gapped PR must retain its first author slot"

# Other authors do not consume slots, even if their PR numbers are lower.
response 35 null 11 developer 51
jq '.[0].data.repository.pullRequests.nodes |= map(
  if .author.login | startswith("other-author-") then .number -= 52 else . end
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
[[ "$output" != *CI_CAPACITY_LIMIT* ]] || fail "one author's excess must not inflate the global pool"
assert_contains "$output" 'CI_AUTHOR_PR_LIMIT'
assert_contains "$output" 'CI candidate PRs: 50'
assert_contains "$summary" 'at most 50 CI candidate PRs'
assert_contains "$summary" "among the author's 50 lowest-numbered open PRs"

response 12 null 6 developer 47
run_admission pull_request 0 12 6
[[ "$status" == 0 ]] || fail "configured limits should allow their exact boundaries: $output"
response 14 null 7 developer 48
run_admission pull_request 0 12 6
[[ "$status" == 1 ]] || fail "both configured limits should reject excess PRs"
assert_contains "$output" '13 CI candidate PRs (14 open PRs; limit: 12)'
assert_contains "$output" 'position 7 by PR number among 7 open PRs'
assert_contains "$summary" 'at most 12 CI candidate PRs'
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
assert_contains "$summary" '**51 CI candidate PRs** (limit: **40**)'
assert_contains "$summary" '**60 open PRs**'
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

# MQ/bypass overlap inside ordinary slots must not double count or refill slots.
author_pools '[12,10,10,10]'
jq '.[0].data.repository.pullRequests.nodes[1].mergeQueueEntry = {id: "queued-43"}' \
  "${test_root}/response.json" >"${test_root}/queue.json"
mv "${test_root}/queue.json" "${test_root}/response.json"
run_admission pull_request 0 40 10 '43,999'
[[ "$status" == 0 ]] || fail "an exception inside the first ten must count once: $output"
assert_contains "$output" 'CI candidate PRs: 40'

# An outside MQ/bypass PR adds one; another outside bypass adds a second.
jq '.[0].data.repository.pullRequests.nodes[10].mergeQueueEntry = {id: "queued-52"}' \
  "${test_root}/response.json" >"${test_root}/queue.json"
mv "${test_root}/queue.json" "${test_root}/response.json"
run_admission pull_request 0 41 10 '43,52,52,999'
[[ "$status" == 0 ]] || fail "overlapping outside exceptions must count once: $output"
assert_contains "$output" 'CI candidate PRs: 41'
run_admission pull_request 0 40 10 '52'
[[ "$status" == 1 ]] || fail "an outside MQ candidate must consume global capacity"
assert_contains "$output" '41 CI candidate PRs'
run_admission pull_request 0 41 10 '52,53,53'
[[ "$status" == 1 ]] || fail "distinct outside exceptions must consume distinct slots"
assert_contains "$output" '42 CI candidate PRs'
run_admission pull_request 0 42 10 '52,53'
[[ "$status" == 0 ]] || fail "the exact exception-union boundary should pass: $output"

# An inside exemption does not grant later ordinary PRs an extra author slot.
author_pools '[12,10,10,10]' 53
run_admission pull_request 0 40 10 '43'
[[ "$status" == 1 ]] || fail "bypassed earlier PRs must still consume their ordinary author positions"
assert_contains "$output" 'position 12 by PR number'
[[ "$output" != *CI_CAPACITY_LIMIT* ]] || fail "inside exemptions must not inflate the denominator"

# Zero ordinary slots still count non-target exceptions.
author_pools '[12,10,10,10]'
jq '.[0].data.repository.pullRequests.nodes[1].mergeQueueEntry = {id: "queued-43"}' \
  "${test_root}/response.json" >"${test_root}/queue.json"
mv "${test_root}/queue.json" "${test_root}/response.json"
run_admission pull_request 0 1 0 '53'
[[ "$status" == 1 ]] || fail "zero author slots must not erase exempt candidates"
assert_contains "$output" '2 CI candidate PRs'
assert_contains "$output" 'CI_AUTHOR_PR_LIMIT'

# Invalid configuration or unavailable GitHub state cannot be bypassed.
response 60 null 30 developer 62
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

# Group complete mixed-author pages before capping, regardless of response order.
author_pools '[60,60]'
jq '
  [.[].data.repository.pullRequests.nodes[]] | reverse
' "${test_root}/response.json" >"${test_root}/nodes.json"
jq --slurpfile nodes "${test_root}/nodes.json" '
  .[0].data.repository.pullRequests.nodes = $nodes[0][0:100] |
  .[1].data.repository.pullRequests.nodes = $nodes[0][100:]
' "${test_root}/response.json" >"${test_root}/paginated.json"
mv "${test_root}/paginated.json" "${test_root}/response.json"
run_admission pull_request 0 20 10
[[ "$status" == 0 ]] || fail "page-local grouping must not inflate the global candidate pool: $output"
assert_contains "$output" 'Open PRs: 120; CI candidate PRs: 20'
jq '.[].data.repository.pullRequests.nodes |= map(
  if .number == 101 then .mergeQueueEntry = {id: "queued-101"} else . end
)' "${test_root}/response.json" >"${test_root}/queue.json"
mv "${test_root}/queue.json" "${test_root}/response.json"
run_admission pull_request 0 20 10 '159'
[[ "$status" == 1 ]] || fail "outside exceptions on mixed pages must consume capacity"
assert_contains "$output" '22 CI candidate PRs (120 open PRs; limit: 20)'

# Execute the actual printed count command with the same mocked provider snapshot.
candidate_command=$(awk '
  $0 == "Check repository CI candidate PRs:" { found = 1; next }
  found && $0 == "```sh" { copy = 1; next }
  copy && $0 == "```" { exit }
  copy { print }
' "${test_root}/summary.md")
[[ -n "$candidate_command" ]] || fail "the effective-count recovery command must be printed"
manual_count=$(
  PATH="${test_root}/bin:$PATH" \
    MOCK_ATTEMPTS="${test_root}/attempts" MOCK_RESPONSE="${test_root}/response.json" MOCK_FAILURES=0 \
    bash -e -o pipefail -c "$candidate_command"
)
[[ "$manual_count" == 22 ]] || fail "the recovery command must match production's distinct pool: $manual_count"
jq '.[-1].data.repository.pullRequests.pageInfo.hasNextPage = true' \
  "${test_root}/response.json" >"${test_root}/invalid.json"
mv "${test_root}/invalid.json" "${test_root}/response.json"
manual_status=0
manual_output=$(
  PATH="${test_root}/bin:$PATH" \
    MOCK_ATTEMPTS="${test_root}/attempts" MOCK_RESPONSE="${test_root}/response.json" MOCK_FAILURES=0 \
    bash -e -o pipefail -c "$candidate_command" 2>&1
) || manual_status=$?
[[ "$manual_status" != 0 ]] || fail "the recovery command must reject incomplete observations"
assert_contains "$manual_output" 'Invalid or incomplete PR CI admission state'

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
  '.[0].data.repository.pullRequests.nodes[0].author.login = "different-author"' \
  'del(.[0].data.repository.pullRequests.nodes[1].author)' \
  '.[0].data.repository.pullRequests.nodes[1].author = {}' \
  '.[0].data.repository.pullRequests.nodes[1].author.login = ""' \
  '.[0].data.repository.pullRequests.nodes[1].author.login = 42' \
  'del(.[0].data.repository.pullRequests.nodes[1].mergeQueueEntry)' \
  '.[0].data.repository.pullRequests.nodes[1].mergeQueueEntry = {}' \
  '.[0].data.repository.pullRequests.nodes[1].mergeQueueEntry.id = ""' \
  '.[0].data.repository.pullRequests.nodes[0].mergeQueueEntry = {id: "inconsistent-target"}'; do
  response 39
  jq "$invalid" "${test_root}/response.json" >"${test_root}/invalid.json"
  mv "${test_root}/invalid.json" "${test_root}/response.json"
  run_admission
  [[ "$status" == 1 ]] || fail "invalid GitHub response must fail closed"
  assert_contains "$output" 'CI_ADMISSION_QUERY_FAILED'
done

# Conflicting target observations across pages must retry instead of undercount.
response 101
jq '.[1].data.repository.pullRequest.mergeQueueEntry = {id: "changed-target"}' \
  "${test_root}/response.json" >"${test_root}/invalid.json"
mv "${test_root}/invalid.json" "${test_root}/response.json"
run_admission
[[ "$status" == 1 ]] || fail "inconsistent target queue observations must fail closed"
assert_contains "$output" 'CI_ADMISSION_QUERY_FAILED'

# Null authors are not one known shared author that may be capped.
response 13
jq '.[0].data.repository.pullRequests.nodes[1:] |= map(.author = null)' \
  "${test_root}/response.json" >"${test_root}/deleted-author.json"
mv "${test_root}/deleted-author.json" "${test_root}/response.json"
run_admission pull_request 0 12 10
[[ "$status" == 1 ]] || fail "unknown authors must each consume a conservative candidate slot"
assert_contains "$output" '13 CI candidate PRs'
[[ "$output" != *CI_AUTHOR_PR_LIMIT* ]] || fail "unknown authors must not consume the target's author positions"

# Unrelated PRs from deleted authors still consume repository capacity only.
response 11 null 10 developer 51
jq '.[0].data.repository.pullRequests.nodes[10].author = null' \
  "${test_root}/response.json" >"${test_root}/deleted-author.json"
mv "${test_root}/deleted-author.json" "${test_root}/response.json"
run_admission pull_request 0 40 10
[[ "$status" == 0 ]] || fail "unrelated deleted authors must not prevent author ranking: $output"

echo "check-pr-ci-capacity-test: ok"
