#!/usr/bin/env bash
set -euo pipefail

# Reserve Neon capacity for queued PRs by rejecting new PR CI runs before any
# preview deployment. Re-runs query current GitHub state rather than the event's
# original snapshot.
if [[ "${EVENT_NAME:?EVENT_NAME is required}" != pull_request ]]; then
  echo "CI capacity admission is only required for pull_request runs."
  exit 0
fi

repository=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}
pr_number=${PR_NUMBER:?PR_NUMBER is required}
run_id=${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}
owner=${repository%%/*}
name=${repository#*/}
limit=40
retry_command="gh run rerun ${run_id} --repo ${repository}"
count_query="query { repository(owner: \"${owner}\", name: \"${name}\") { pullRequests(states: OPEN) { totalCount } } }"
count_command="gh api graphql -f query='${count_query}' --jq '.data.repository.pullRequests.totalCount'"

query="query(\$owner: String!, \$name: String!, \$number: Int!) {
  repository(owner: \$owner, name: \$name) {
    pullRequests(states: OPEN) { totalCount }
    pullRequest(number: \$number) { number mergeQueueEntry { id } }
  }
}"

response=""
for attempt in 1 2 3; do
  if response=$(gh api graphql -f query="$query" \
    -f owner="$owner" -f name="$name" -F number="$pr_number") &&
    jq -e --argjson number "$pr_number" '
      ((.errors // []) | length == 0) and
      (.data.repository.pullRequests.totalCount | type == "number" and . >= 0 and . == floor) and
      (.data.repository.pullRequest.number == $number) and
      (.data.repository.pullRequest | has("mergeQueueEntry")) and
      (.data.repository.pullRequest.mergeQueueEntry |
        . == null or (.id | type == "string" and length > 0))
    ' <<<"$response" >/dev/null; then
    break
  fi
  response=""
  echo "Could not query valid PR CI admission state (attempt ${attempt}/3)." >&2
  if [[ "$attempt" != 3 ]]; then
    sleep 2
  fi
done

if [[ -z "$response" ]]; then
  message="CI_ADMISSION_QUERY_FAILED: Could not determine the open PR count and merge queue membership after 3 attempts. Re-run this workflow after GitHub API access recovers: ${retry_command}"
  printf '::error title=CI admission query failed::%s\n' "$message"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '### CI admission query failed\n\n%s\n' "$message" >>"$GITHUB_STEP_SUMMARY"
  fi
  exit 1
fi

open_pr_count=$(jq -r '.data.repository.pullRequests.totalCount' <<<"$response")
in_merge_queue=$(jq -r '.data.repository.pullRequest.mergeQueueEntry != null' <<<"$response")
echo "Open PRs: ${open_pr_count}; limit: ${limit}; PR #${pr_number} in merge queue: ${in_merge_queue}"

if ((open_pr_count > limit)) && [[ "$in_merge_queue" == false ]]; then
  message="CI_CAPACITY_LIMIT: ${repository} has ${open_pr_count} open PRs (limit: ${limit}). PR #${pr_number} is not in the merge queue. CI is paused to reserve Neon branch capacity for queued PRs. Wait until the open PR count is below ${limit}, then re-run the entire workflow: ${retry_command}"
  printf '::error title=PR CI capacity limit::%s\n' "$message"
  printf 'Check the current open PR count:\n%s\n' "$count_command"
  echo "This is a temporary capacity limit, not a code or test failure. The PR cannot enter the merge queue until its required CI passes."
  echo "PR owners and agents: check the count later and retry this workflow when it is below 40. Do not repeatedly retry while capacity is exhausted."

  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      printf '### PR CI paused by capacity limit\n\n'
      printf '%s has **%s open PRs**, exceeding the limit of **%s**. PR **#%s** is **not in the merge queue**.\n\n' \
        "$repository" "$open_pr_count" "$limit" "$pr_number"
      printf '%s\n\n' \
        'CI stopped before preview deployment to reserve Neon branch capacity for queued PRs.' \
        'This is a temporary capacity limit, not a code or test failure. Required CI must pass before this PR can enter the merge queue.' \
        'PR owners and agents: check the open PR count later. Once it is below 40, re-run the entire workflow. Do not repeatedly retry while capacity is exhausted.'
      printf "Check the current count (including draft and bot PRs):\n\n\`\`\`sh\n%s\n\`\`\`\n\n" "$count_command"
      printf "Re-run this entire workflow after capacity recovers:\n\n\`\`\`sh\n%s\n\`\`\`\n" "$retry_command"
    } >>"$GITHUB_STEP_SUMMARY"
  fi
  exit 1
fi

echo "PR CI capacity admission passed."
