#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 2
  fi
}

require_env GH_TOKEN
require_env GITHUB_REPOSITORY
require_env GITHUB_RUN_ID

if [[ ! "$GITHUB_RUN_ID" =~ ^[0-9]+$ ]]; then
  echo "invalid GITHUB_RUN_ID: ${GITHUB_RUN_ID}" >&2
  exit 2
fi

owner_scope=${RUNNER_OWNER_SCOPE:-superseded}
case "$owner_scope" in
  superseded)
    require_env GITHUB_SHA
    require_env MERGE_GROUP_HEAD_REF
    pr_number=$(
      printf '%s\n' "$MERGE_GROUP_HEAD_REF" |
        grep -oE 'pr-[0-9]+' |
        head -1 |
        sed 's/pr-//' || true
    )
    if [ -z "$pr_number" ]; then
      echo "failed to extract PR number from merge_group head_ref: ${MERGE_GROUP_HEAD_REF}" >&2
      exit 2
    fi
    selected_runs_label="superseded CI runs"
    selected_run_label="superseded run"
    ;;
  closed-pr-cleanup)
    require_env PR_NUMBER
    pr_number=${PR_NUMBER:-}
    selected_runs_label="active runner-owner CI runs"
    selected_run_label="active runner-owner run"
    ;;
  *)
    echo "invalid RUNNER_OWNER_SCOPE: ${owner_scope}" >&2
    exit 2
    ;;
esac

if [[ ! "$pr_number" =~ ^[0-9]+$ ]]; then
  echo "invalid PR number: ${pr_number}" >&2
  exit 2
fi

if ! pr_head=$(
  gh api --method GET \
    "repos/${GITHUB_REPOSITORY}/pulls/${pr_number}" \
    --jq '[.head.ref, .head.repo.full_name, .state] | @tsv' 2>&1
); then
  echo "failed to resolve PR #${pr_number} head: ${pr_head}" >&2
  exit 1
fi
IFS=$'\t' read -r pr_head_ref pr_head_repository pr_state <<<"$pr_head"
if [ -z "$pr_head_ref" ] || [ -z "$pr_head_repository" ] || [ -z "$pr_state" ]; then
  echo "failed to resolve head repository, ref and state for PR #${pr_number}" >&2
  exit 1
fi
if [ "$owner_scope" = "closed-pr-cleanup" ] && [ "$pr_state" != "closed" ]; then
  echo "refusing to cancel CI for PR #${pr_number} in state ${pr_state}" >&2
  exit 1
fi

timeout_seconds=${SUPERSEDED_RUN_TIMEOUT_SECONDS:-180}
if [[ ! "$timeout_seconds" =~ ^[0-9]+$ ]]; then
  echo "run discovery timeout must be a non-negative integer" >&2
  exit 2
fi

discover_selected_runs() {
  local active_statuses=(queued in_progress pending waiting requested)
  local status

  for status in "${active_statuses[@]}"; do
    if ! gh api --method GET \
      "repos/${GITHUB_REPOSITORY}/actions/runs" \
      -f "status=${status}" \
      -f per_page=100 \
      --paginate \
      --slurp; then
      return 1
    fi
  done |
    jq -r \
      --argjson current_run_id "$GITHUB_RUN_ID" \
      --arg current_head_sha "${GITHUB_SHA:-}" \
      --arg owner_scope "$owner_scope" \
      --argjson pr_number "$pr_number" \
      --arg pr_head_ref "$pr_head_ref" \
      --arg pr_head_repository "$pr_head_repository" '
        .[] | .workflow_runs[]?
        | select(
            if $owner_scope == "closed-pr-cleanup" then
              .id != $current_run_id
            else
              .id < $current_run_id and .head_sha != $current_head_sha
            end
          )
        | select(
            .path == ".github/workflows/turbo.yml" or
            .path == ".github/workflows/crates.yml" or
            .path == ".github/workflows/runner-image.yml"
          )
        | select(
            (
              .event == "merge_group" and
              ((.head_branch // "") | test("(^|/)pr-" + ($pr_number | tostring) + "-"))
            ) or
            (
              .event == "pull_request" and
              (
                any(.pull_requests[]?; .number == $pr_number) or
                (
                  ((.head_branch // "") == $pr_head_ref) and
                  ((.head_repository.full_name // "") == $pr_head_repository)
                )
              )
            )
          )
        | [.id, .name, .status, .event, .head_sha, .html_url, .path]
        | @tsv
      ' |
    sort -n -u
}

previous_run_ids=""
have_previous_run_ids=false
discovery_started_at=$SECONDS
# Each status filter is a separate API snapshot. Require the selected run IDs
# to stabilize so a run changing statuses cannot fall between those snapshots.
while true; do
  if ! discovered_runs=$(discover_selected_runs 2>&1); then
    echo "failed to discover ${selected_runs_label}: ${discovered_runs}" >&2
    exit 1
  fi
  discovered_run_ids=$(printf '%s\n' "$discovered_runs" | cut -f1)

  if $have_previous_run_ids; then
    if [ "$discovered_run_ids" = "$previous_run_ids" ]; then
      selected_runs=$discovered_runs
      break
    fi

    if ((SECONDS - discovery_started_at >= timeout_seconds)); then
      echo "::error::Timed out waiting for ${selected_runs_label} discovery to stabilize" >&2
      exit 1
    fi
  fi

  previous_run_ids=$discovered_run_ids
  have_previous_run_ids=true
done

if [ -z "$selected_runs" ]; then
  echo "No ${selected_runs_label} found for PR #${pr_number}."
  exit 0
fi

echo "Cancelling ${selected_runs_label} for PR #${pr_number}:"
printf '%s\n' "$selected_runs"

cancel_runs() {
  local records=$1 run_record run_id cancel_error cancel_status
  [ -n "$records" ] || return 0

  while IFS= read -r run_record; do
    run_id=${run_record%%$'\t'*}
    if ! cancel_error=$(gh api --method POST \
      "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/force-cancel" --include 2>&1); then
      cancel_status=$(awk '/^HTTP\// { print $2; exit }' <<<"$cancel_error")
      if [ "$cancel_status" != "409" ]; then
        echo "failed to cancel ${selected_run_label} ${run_id}: ${cancel_error}" >&2
        return 1
      fi
      echo "Cancellation conflict for ${selected_run_label} ${run_id}; continuing without waiting."
    fi
  done <<<"$records"
}

consumers=$(awk -F '\t' '$7 != ".github/workflows/runner-image.yml"' <<<"$selected_runs")
producers=$(awk -F '\t' '$7 == ".github/workflows/runner-image.yml"' <<<"$selected_runs")
# Request consumer cancellation first, then producer cancellation. GitHub's
# top-level run status can remain active after every job has finished.
cancel_runs "$consumers"
cancel_runs "$producers"
echo "Requested cancellation of ${selected_runs_label}; continuing without waiting for completion."
