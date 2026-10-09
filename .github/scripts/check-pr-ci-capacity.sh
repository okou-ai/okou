#!/usr/bin/env bash
set -euo pipefail

# Budget effective PR candidates before preview deployment, not running jobs or
# live Neon branches. Re-runs query current GitHub state rather than the event's
# original snapshot.
if [[ "${EVENT_NAME:?EVENT_NAME is required}" != pull_request ]]; then
  echo "CI admission limits are only required for pull_request runs."
  exit 0
fi

repository=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}
pr_number=${PR_NUMBER:?PR_NUMBER is required}
run_id=${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}
owner=${repository%%/*}
name=${repository#*/}
retry_command="gh run rerun ${run_id} --repo ${repository}"
count_query="query { repository(owner: \"${owner}\", name: \"${name}\") { pullRequests(states: OPEN) { totalCount } } }"
count_command="gh api graphql -f query='${count_query}' --jq '.data.repository.pullRequests.totalCount'"

query="query(\$owner: String!, \$name: String!, \$number: Int!, \$endCursor: String) {
  repository(owner: \$owner, name: \$name) {
    pullRequests(states: OPEN, first: 100, after: \$endCursor, orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount
      nodes { number author { login } mergeQueueEntry { id } }
      pageInfo { hasNextPage endCursor }
    }
    pullRequest(number: \$number) { number author { login } mergeQueueEntry { id } }
  }
}"

response_validation_filter=$(cat <<'JQ'
  .[0].data.repository.pullRequest as $target |
  type == "array" and length > 0 and
  all(.[];
    ((.errors // []) | length == 0) and
    (.data.repository.pullRequests.totalCount | type == "number" and . >= 0 and . == floor) and
    (.data.repository.pullRequest.number == $number) and
    (.data.repository.pullRequest == $target) and
    (.data.repository.pullRequest.author.login | type == "string" and length > 0) and
    (.data.repository.pullRequest | has("mergeQueueEntry")) and
    (.data.repository.pullRequest.mergeQueueEntry |
      . == null or (.id | type == "string" and length > 0)) and
    (.data.repository.pullRequests.nodes | type == "array" and all(.[];
      (.number | type == "number" and . > 0 and . == floor) and
      has("author") and
      (.author | . == null or (.login | type == "string" and length > 0)) and
      has("mergeQueueEntry") and
      (.mergeQueueEntry | . == null or (.id | type == "string" and length > 0))
    ))
  ) and
  (.[-1].data.repository.pullRequests.pageInfo.hasNextPage == false) and
  ([.[].data.repository.pullRequests.nodes[]] | length) == .[0].data.repository.pullRequests.totalCount and
  ([.[].data.repository.pullRequests.nodes[].number] | length == (unique | length)) and
  ([.[].data.repository.pullRequests.nodes[] | select(.number == $number)] |
    length == 1 and .[0].author.login == $target.author.login and
    .[0].mergeQueueEntry == $target.mergeQueueEntry)
JQ
)
response=""
for attempt in 1 2 3; do
  if response=$(gh api graphql --paginate --slurp -f query="$query" \
    -f owner="$owner" -f name="$name" -F number="$pr_number") &&
    jq -e --argjson number "$pr_number" "$response_validation_filter" <<<"$response" >/dev/null; then
    break
  fi
  response=""
  echo "Could not query valid PR CI admission state (attempt ${attempt}/3)." >&2
  if [[ "$attempt" != 3 ]]; then
    sleep 2
  fi
done

if [[ -z "$response" ]]; then
  message="CI_ADMISSION_QUERY_FAILED: Could not determine repository and author open PR counts, PR-number position, and merge queue membership after 3 attempts. Re-run this workflow after GitHub API access recovers: ${retry_command}"
  printf '::error title=CI admission query failed::%s\n' "$message"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '### CI admission query failed\n\n%s\n' "$message" >>"$GITHUB_STEP_SUMMARY"
  fi
  exit 1
fi

open_pr_count=$(jq -r '.[0].data.repository.pullRequests.totalCount' <<<"$response")
author=$(jq -r '.[0].data.repository.pullRequest.author.login' <<<"$response")
author_pr_count=$(jq --arg author "$author" '[.[].data.repository.pullRequests.nodes[] | select(.author.login == $author)] | length' <<<"$response")
author_pr_position=$(jq --arg author "$author" --argjson number "$pr_number" '
  [.[].data.repository.pullRequests.nodes[] | select(.author.login == $author)] |
  sort_by(.number) | map(.number) | index($number) + 1
' <<<"$response")
in_merge_queue=$(jq -r '.[0].data.repository.pullRequest.mergeQueueEntry != null' <<<"$response")
if [[ "$in_merge_queue" == true ]]; then
  echo "Open PRs: ${open_pr_count}; author ${author}: ${author_pr_count} open PRs; PR #${pr_number} in merge queue: true. Admission limits do not apply to queued PRs."
  exit 0
fi

# GitHub's PR counts are GraphQL Int values. Validate configuration before Bash
# arithmetic so missing, malformed, or overflowing values cannot grant admission.
for variable in CI_MAX_OPEN_PRS CI_MAX_OPEN_PRS_PER_AUTHOR; do
  value=${!variable:-}
  if [[ ! "$value" =~ ^(0|[1-9][0-9]{0,9})$ ]] || ((value > 2147483647)); then
    message="CI_ADMISSION_CONFIG_INVALID: ${variable} must be an integer from 0 to 2147483647. Configure the repository Actions variables at https://github.com/${repository}/settings/variables/actions."
    printf '::error title=CI admission configuration invalid::%s\n' "$message"
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
      printf '### CI admission configuration invalid\n\n%s\n' "$message" >>"$GITHUB_STEP_SUMMARY"
    fi
    exit 1
  fi
done
limit=$CI_MAX_OPEN_PRS
author_limit=$CI_MAX_OPEN_PRS_PER_AUTHOR

# Like the runner cleanup PR selector, accept comma-separated positive PR
# numbers with surrounding whitespace. Empty configuration grants no bypass.
if ! bypass_numbers=$(jq -cn --arg list "${CI_PR_ADMISSION_BYPASS_LIST:-}" '
  $list | gsub("^\\s+|\\s+$"; "") |
  if . == "" then []
  else
    split(",") | map(gsub("^\\s+|\\s+$"; "")) |
    if all(.[]; test("^[1-9][0-9]{0,9}$")) then
      map(tonumber) |
      if all(.[]; . <= 2147483647) then .
      else error("PR number out of range") end
    else error("Invalid PR number list") end
  end
' 2>/dev/null); then
  message="CI_ADMISSION_CONFIG_INVALID: CI_PR_ADMISSION_BYPASS_LIST must be empty or contain comma-separated PR numbers from 1 to 2147483647 (for example: 38089,38123). Configure the repository Actions variables at https://github.com/${repository}/settings/variables/actions."
  printf '::error title=CI admission configuration invalid::%s\n' "$message"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '### CI admission configuration invalid\n\n%s\n' "$message" >>"$GITHUB_STEP_SUMMARY"
  fi
  exit 1
fi

# Share the set expression with the recovery command. Unknown authors have no
# known shared identity, so keep their PRs individually rather than cap a group.
candidate_count_filter=$(cat <<'JQ'
  [.[].data.repository.pullRequests.nodes[]] as $prs |
  [$prs | group_by(.author.login)[] |
    if .[0].author == null then .[]
    else sort_by(.number)[:$author_limit][] end
  ] + [$prs[] | select(.mergeQueueEntry != null or
    (.number as $number | $bypass_numbers | index($number) != null))] |
  unique_by(.number) | length
JQ
)
candidate_pr_count=$(jq --argjson author_limit "$author_limit" --argjson bypass_numbers "$bypass_numbers" \
  "$candidate_count_filter" <<<"$response")
candidate_count_command="set -o pipefail; gh api graphql --paginate --slurp -f query='${query}' -f owner='${owner}' -f name='${name}' -F number=${pr_number} | jq -e --argjson number ${pr_number} --argjson author_limit ${author_limit} --argjson bypass_numbers '${bypass_numbers}' 'if (${response_validation_filter}) then (${candidate_count_filter}) else error(\"Invalid or incomplete PR CI admission state\") end'"
candidate_policy="CI candidates are each known author's ${author_limit} lowest-numbered open PRs plus queued and bypass-listed PRs, counted once. PRs with unknown authors count individually. This is not a count of running jobs or live Neon branches."
author_position_command="gh api --paginate --slurp 'repos/${repository}/pulls?state=open&per_page=100' | jq 'add | map(select(.user.login == \"${author}\")) | sort_by(.number) | map(.number) | index(${pr_number}) | if . == null then error(\"PR is not open\") else . + 1 end'"
echo "Open PRs: ${open_pr_count}; CI candidate PRs: ${candidate_pr_count}; limit: ${limit}; author ${author}: ${author_pr_count} open PRs; PR #${pr_number} author position (lowest PR number first): ${author_pr_position}; author limit: ${author_limit}; PR #${pr_number} in merge queue: ${in_merge_queue}"
echo "$candidate_policy"

if jq -e --argjson number "$pr_number" 'index($number) != null' <<<"$bypass_numbers" >/dev/null; then
  message="CI_PR_ADMISSION_BYPASS: PR #${pr_number} is listed in CI_PR_ADMISSION_BYPASS_LIST. Repository and author PR count limits do not apply to this PR. Normal CI and required checks still run."
  echo "$message"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '### PR CI admission limits bypassed\n\n%s\n\nRepository: **%s CI candidate PRs** (limit: **%s**); **%s open PRs**. Author **%s**: **%s open PRs** (limit: **%s**).\n\n%s\n' \
      "$message" "$candidate_pr_count" "$limit" "$open_pr_count" "$author" "$author_pr_count" "$author_limit" "$candidate_policy" >>"$GITHUB_STEP_SUMMARY"
  fi
  exit 0
fi

reasons=()
if ((candidate_pr_count > limit)); then
  reasons+=("CI_CAPACITY_LIMIT: ${repository} has ${candidate_pr_count} CI candidate PRs (${open_pr_count} open PRs; limit: ${limit}).")
fi
if ((author_pr_position > author_limit)); then
  reasons+=("CI_AUTHOR_PR_LIMIT: PR #${pr_number} is at position ${author_pr_position} by PR number among ${author_pr_count} open PRs by ${author} in ${repository} (limit: ${author_limit}).")
fi

if ((${#reasons[@]} > 0)); then
  printf '::error title=PR CI admission limit::%s\n' "${reasons[@]}"
  echo "PR #${pr_number} is not in the merge queue. CI stopped before preview deployment to limit the eligible PR candidate pool."
  echo "This is a temporary admission limit, not a code or test failure. The PR cannot enter the merge queue until its required CI passes."
  echo "PR owners and agents: check the repository candidate count and this PR's author position later. Retry once the repository has at most ${limit} CI candidate PRs and this PR is among the author's ${author_limit} lowest-numbered open PRs. Do not repeatedly retry while either limit is exceeded."
  printf "Check repository CI candidate PRs:\n%s\nCheck raw repository open PRs:\n%s\nCheck this PR's author position (lowest PR number first):\n%s\nRe-run the entire workflow after both limits recover:\n%s\n" \
    "$candidate_count_command" "$count_command" "$author_position_command" "$retry_command"

  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      printf '### PR CI paused by admission limits\n\n'
      printf 'Repository %s: **%s CI candidate PRs** (limit: **%s**); **%s open PRs**. Author **%s**: **%s open PRs** in this repository; PR **#%s** is at PR-number position **%s** (lowest PR number first; limit: **%s**) and is **not in the merge queue**.\n\n' \
        "$repository" "$candidate_pr_count" "$limit" "$open_pr_count" "$author" "$author_pr_count" "$pr_number" "$author_pr_position" "$author_limit"
      printf '%s\n\n' "$candidate_policy"
      printf '%s\n\n' "${reasons[@]}"
      printf '%s\n\n' \
        'CI stopped before preview deployment to limit the eligible PR candidate pool.' \
        'This is a temporary admission limit, not a code or test failure. Required CI must pass before this PR can enter the merge queue.' \
        "PR owners and agents: once the repository has at most ${limit} CI candidate PRs and this PR is among the author's ${author_limit} lowest-numbered open PRs, re-run the entire workflow. Closing or merging lower-numbered PRs frees author slots. Do not repeatedly retry while either limit is exceeded."
      printf "Check repository CI candidate PRs:\n\n\`\`\`sh\n%s\n\`\`\`\n\n" "$candidate_count_command"
      printf "Check raw repository open PRs (including draft and bot PRs):\n\n\`\`\`sh\n%s\n\`\`\`\n\n" "$count_command"
      printf "Check this PR's PR-number position among the author's open PRs (including draft and bot PRs):\n\n\`\`\`sh\n%s\n\`\`\`\n\n" "$author_position_command"
      printf "Re-run this entire workflow after both limits recover:\n\n\`\`\`sh\n%s\n\`\`\`\n" "$retry_command"
    } >>"$GITHUB_STEP_SUMMARY"
  fi
  exit 1
fi

echo "PR CI admission limits passed."
