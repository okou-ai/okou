#!/usr/bin/env bash
# Report whether a commit's CLI artifact may still become available. A failed
# job may have uploaded it, while only a skipped job proves its steps never ran.
set -euo pipefail

: "${ARTIFACT_SHA:?ARTIFACT_SHA is required}"
: "${GITHUB_EVENT_NAME:?GITHUB_EVENT_NAME is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

if [[ ! "$ARTIFACT_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "invalid CLI artifact commit SHA: $ARTIFACT_SHA" >&2
  exit 2
fi

case "$GITHUB_EVENT_NAME" in
  pull_request|merge_group)
    workflow=turbo.yml
    job_name=deploy-cli
    ;;
  push)
    workflow=staging.yml
    job_name='deploy-and-test / deploy-cli'
    ;;
  *)
    echo "unsupported CLI publisher event: $GITHUB_EVENT_NAME" >&2
    exit 2
    ;;
esac

repo="$GITHUB_REPOSITORY"
runs_endpoint="repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${ARTIFACT_SHA}&event=${GITHUB_EVENT_NAME}&per_page=100"
runs_json=$(gh api "$runs_endpoint")
runs=$(jq -c --arg sha "$ARTIFACT_SHA" --arg event "$GITHUB_EVENT_NAME" '
  [.workflow_runs[] | select(.head_sha == $sha and .event == $event)]
  | sort_by(.created_at, .id) | reverse
' <<<"$runs_json")
run_count=$(jq 'length' <<<"$runs")
total_count=$(jq -er '.total_count' <<<"$runs_json")

# The workflow-runs API is paginated. If this page does not contain every
# matching run, an unseen publisher may still be active or successful.
if (( run_count == 0 || total_count > run_count )); then
  echo pending
  exit 0
fi

run_rows=$(jq -c '.[]' <<<"$runs")
while IFS= read -r run; do
  run_id=$(jq -er '.id' <<<"$run")
  run_status=$(jq -er '.status' <<<"$run")
  jobs_endpoint="repos/${repo}/actions/runs/${run_id}/jobs?filter=all&per_page=100"
  # A rerun may omit deploy-cli from the latest attempt even though an earlier
  # attempt published it. Inspect every attempt and page before deciding that
  # this run had no publisher.
  job_rows=$(gh api --paginate "$jobs_endpoint" --jq '
    .jobs[] | select(.name == "deploy-cli" or .name == "deploy-and-test / deploy-cli")
    | {id, name, status, conclusion}
  ')
  job_state=$(jq -sr --arg name "$job_name" '
    [ .[] | select(.name == $name) ] |
    if length == 0 then "absent"
    elif any(.[]; .status != "completed" or .conclusion != "skipped") then "pending"
    else "skipped" end
  ' <<<"$job_rows")

  if [[ "$job_state" == absent ]]; then
    if [[ "$run_status" != completed ]]; then
      echo pending
      exit 0
    fi
    continue
  fi

  # Only skipped jobs prove their upload steps never ran. A failed, cancelled,
  # or timed-out attempt may have written ready.json before a later step failed.
  if [[ "$job_state" == pending ]]; then
    echo pending
    exit 0
  fi
  # Other runs for this SHA may still publish the same artifact.
done <<<"$run_rows"

echo unavailable
