#!/usr/bin/env bash
# Report whether the workflow that publishes a commit's CLI artifact can still
# publish it. An absent or active run is not evidence that publication is over.
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
run=$(jq -c --arg sha "$ARTIFACT_SHA" --arg event "$GITHUB_EVENT_NAME" '
  [.workflow_runs[] | select(.head_sha == $sha and .event == $event)]
  | sort_by(.created_at, .id)
  | last // empty
' <<<"$runs_json")

if [[ -z "$run" ]]; then
  echo pending
  exit 0
fi

run_id=$(jq -er '.id' <<<"$run")
run_status=$(jq -er '.status' <<<"$run")
jobs_endpoint="repos/${repo}/actions/runs/${run_id}/jobs?per_page=100"
# Turbo and Staging can exceed one jobs page because of test matrices. The
# exact deploy-cli job may be on a later page; an incomplete list must never
# be mistaken for an absent publisher.
job_rows=$(gh api --paginate "$jobs_endpoint" --jq '
  .jobs[] | select(.name == "deploy-cli" or .name == "deploy-and-test / deploy-cli")
  | {id, name, status, conclusion}
')
job=$(jq -sc --arg name "$job_name" '
  [ .[] | select(.name == $name) ] | sort_by(.id) | last // empty
' <<<"$job_rows")

if [[ -z "$job" ]]; then
  if [[ "$run_status" == completed ]]; then
    echo unavailable
  else
    echo pending
  fi
  exit 0
fi

job_status=$(jq -er '.status' <<<"$job")
job_conclusion=$(jq -r '.conclusion // empty' <<<"$job")
if [[ "$job_status" != completed || "$job_conclusion" == success ]]; then
  echo pending
else
  case "$job_conclusion" in
    failure|cancelled|skipped|timed_out|action_required|startup_failure)
      echo unavailable
      ;;
    *)
      # Unknown GitHub conclusions are not proof that publication is over.
      echo pending
      ;;
  esac
fi
