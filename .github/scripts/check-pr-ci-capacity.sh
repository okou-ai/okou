#!/usr/bin/env bash
set -euo pipefail

# Reserve Neon capacity and limit each author's open PRs by rejecting unqueued
# PR CI runs before preview deployment. Re-runs query current GitHub state
# rather than the event's original snapshot.
if [[ "${EVENT_NAME:?EVENT_NAME is required}" != pull_request ]]; then
  echo "CI admission limits are only required for pull_request runs."
  exit 0
fi

repository=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}
pr_number=${PR_NUMBER:?PR_NUMBER is required}
run_id=${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}
owner=${repository%%/*}
name=${repository#*/}
limit=40
author_limit=20
retry_command="gh run rerun ${run_id} --repo ${repository}"
count_query="query { repository(owner: \"${owner}\", name: \"${name}\") { pullRequests(states: OPEN) { totalCount } } }"
count_command="gh api graphql -f query='${count_query}' --jq '.data.repository.pullRequests.totalCount'"

query="query(\$owner: String!, \$name: String!, \$number: Int!, \$endCursor: String) {
  repository(owner: \$owner, name: \$name) {
    pullRequests(states: OPEN, first: 100, after: \$endCursor, orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount
      nodes { number author { login } }
      pageInfo { hasNextPage endCursor }
    }
    pullRequest(number: \$number) { number author { login } mergeQueueEntry { id } }
  }
}"

response=""
for attempt in 1 2 3; do
  if response=$(gh api graphql --paginate --slurp -f query="$query" \
    -f owner="$owner" -f name="$name" -F number="$pr_number") &&
    jq -e --argjson number "$pr_number" '
      type == "array" and length > 0 and
      all(.[];
        ((.errors // []) | length == 0) and
        (.data.repository.pullRequests.totalCount | type == "number" and . >= 0 and . == floor) and
        (.data.repository.pullRequest.number == $number) and
        (.data.repository.pullRequest.author.login | type == "string" and length > 0) and
        (.data.repository.pullRequest | has("mergeQueueEntry")) and
        (.data.repository.pullRequest.mergeQueueEntry |
          . == null or (.id | type == "string" and length > 0)) and
        (.data.repository.pullRequests.nodes | type == "array" and all(.[]; has("author")))
      ) and
      (.[-1].data.repository.pullRequests.pageInfo.hasNextPage == false) and
      ([.[].data.repository.pullRequests.nodes[]] | length) == .[0].data.repository.pullRequests.totalCount
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
  message="CI_ADMISSION_QUERY_FAILED: Could not determine repository and author open PR counts and merge queue membership after 3 attempts. Re-run this workflow after GitHub API access recovers: ${retry_command}"
  printf '::error title=CI admission query failed::%s\n' "$message"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '### CI admission query failed\n\n%s\n' "$message" >>"$GITHUB_STEP_SUMMARY"
  fi
  exit 1
fi

open_pr_count=$(jq -r '.[0].data.repository.pullRequests.totalCount' <<<"$response")
author=$(jq -r '.[0].data.repository.pullRequest.author.login' <<<"$response")
author_pr_count=$(jq --arg author "$author" '[.[].data.repository.pullRequests.nodes[] | select(.author.login == $author)] | length' <<<"$response")
in_merge_queue=$(jq -r '.[0].data.repository.pullRequest.mergeQueueEntry != null' <<<"$response")
author_count_command="gh api --paginate --slurp 'repos/${repository}/pulls?state=open&per_page=100' | jq 'add | map(select(.user.login == \"${author}\")) | length'"
echo "Open PRs: ${open_pr_count}; limit: ${limit}; author ${author}: ${author_pr_count} open PRs; author limit: ${author_limit}; PR #${pr_number} in merge queue: ${in_merge_queue}"

reasons=()
if [[ "$in_merge_queue" == false ]]; then
  if ((open_pr_count > limit)); then
    reasons+=("CI_CAPACITY_LIMIT: ${repository} has ${open_pr_count} open PRs (limit: ${limit}).")
  fi
  if ((author_pr_count > author_limit)); then
    reasons+=("CI_AUTHOR_PR_LIMIT: Author ${author} has ${author_pr_count} open PRs in ${repository} (limit: ${author_limit}).")
  fi
fi

if ((${#reasons[@]} > 0)); then
  printf '::error title=PR CI admission limit::%s\n' "${reasons[@]}"
  echo "PR #${pr_number} is not in the merge queue. CI stopped before preview deployment to enforce PR concurrency limits and reserve Neon branch capacity for queued PRs."
  echo "This is a temporary admission limit, not a code or test failure. The PR cannot enter the merge queue until its required CI passes."
  echo "PR owners and agents: check both counts later. Retry once the repository has fewer than 40 open PRs and this author has at most 20 open PRs. Do not repeatedly retry while either limit is exceeded."
  printf 'Check repository open PRs:\n%s\nCheck author open PRs:\n%s\nRe-run the entire workflow after both limits recover:\n%s\n' \
    "$count_command" "$author_count_command" "$retry_command"

  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      printf '### PR CI paused by admission limits\n\n'
      printf 'Repository %s: **%s open PRs** (limit: **%s**). Author **%s**: **%s open PRs** in this repository (limit: **%s**). PR **#%s** is **not in the merge queue**.\n\n' \
        "$repository" "$open_pr_count" "$limit" "$author" "$author_pr_count" "$author_limit" "$pr_number"
      printf '%s\n\n' "${reasons[@]}"
      printf '%s\n\n' \
        'CI stopped before preview deployment to enforce PR concurrency limits and reserve Neon branch capacity for queued PRs.' \
        'This is a temporary admission limit, not a code or test failure. Required CI must pass before this PR can enter the merge queue.' \
        'PR owners and agents: check both counts later. Once the repository has fewer than 40 open PRs and this author has at most 20 open PRs, re-run the entire workflow. Do not repeatedly retry while either limit is exceeded.'
      printf "Check repository open PRs (including draft and bot PRs):\n\n\`\`\`sh\n%s\n\`\`\`\n\n" "$count_command"
      printf "Check this author's open PRs in the same repository:\n\n\`\`\`sh\n%s\n\`\`\`\n\n" "$author_count_command"
      printf "Re-run this entire workflow after both limits recover:\n\n\`\`\`sh\n%s\n\`\`\`\n" "$retry_command"
    } >>"$GITHUB_STEP_SUMMARY"
  fi
  exit 1
fi

echo "PR CI admission limits passed."
