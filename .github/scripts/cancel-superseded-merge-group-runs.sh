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
assert_idle=${RUNNER_OWNER_ASSERT_IDLE:-false}
case "$assert_idle" in
  true|false) ;;
  *)
    echo "invalid RUNNER_OWNER_ASSERT_IDLE: ${assert_idle}" >&2
    exit 2
    ;;
esac
case "$owner_scope" in
  superseded)
    require_env GITHUB_SHA
    case "${RUNNER_OWNER_EVENT_NAME:-merge_group}" in
      pull_request)
        require_env PR_NUMBER
        pr_number=${PR_NUMBER:-}
        ;;
      merge_group)
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
        ;;
      *)
        echo "unsupported superseded runner-owner event" >&2
        exit 2
        ;;
    esac
    selected_runs_label="superseded CI runs"
    selected_run_label="superseded run"
    completion_boundary="shared resources were reused"
    cancel_selected_runs=true
    ;;
  closed-pr-cleanup)
    require_env PR_NUMBER
    pr_number=${PR_NUMBER:-}
    selected_runs_label="active runner-owner CI runs"
    selected_run_label="active runner-owner run"
    completion_boundary="closed-PR resource cleanup starts"
    cancel_selected_runs=false
    ;;
  *)
    echo "invalid RUNNER_OWNER_SCOPE: ${owner_scope}" >&2
    exit 2
    ;;
esac
if [ "$assert_idle" = "true" ] && [ "$owner_scope" != "closed-pr-cleanup" ]; then
  echo "RUNNER_OWNER_ASSERT_IDLE is only valid for closed-PR cleanup" >&2
  exit 2
fi

if [[ ! "$pr_number" =~ ^[0-9]+$ ]]; then
  echo "invalid PR number: ${pr_number}" >&2
  exit 2
fi

if ! pr_head=$(
  gh api --method GET \
    "repos/${GITHUB_REPOSITORY}/pulls/${pr_number}" \
    --jq '[.head.ref, .head.repo.full_name] | @tsv' 2>&1
); then
  if $cancel_selected_runs; then
    echo "::warning::failed to resolve PR #${pr_number} head; continuing without cancellation: ${pr_head}" >&2
    exit 0
  fi
  echo "failed to resolve PR #${pr_number} head: ${pr_head}" >&2
  exit 1
fi
IFS=$'\t' read -r pr_head_ref pr_head_repository <<<"$pr_head"
if [ -z "$pr_head_ref" ] || [ -z "$pr_head_repository" ]; then
  if $cancel_selected_runs; then
    echo "::warning::failed to resolve head repository and ref for PR #${pr_number}; continuing without cancellation" >&2
    exit 0
  fi
  echo "failed to resolve head repository and ref for PR #${pr_number}" >&2
  exit 1
fi

poll_seconds=${SUPERSEDED_RUN_POLL_SECONDS:-2}
timeout_seconds=${SUPERSEDED_RUN_TIMEOUT_SECONDS:-180}
# Discovery and the terminal-state barrier wait for different things, so they
# get different ceilings. Force-cancel only *requests* termination: when a
# superseded job is wedged in a step that never returns, GitHub reaps it on its
# own hard-kill schedule, bounded at five minutes from when cancellation began,
# and force-cancel does not shorten that. Superseded runs that wind down
# normally still clear this barrier in a couple of seconds, so the larger
# ceiling only covers the wedged case instead of relaxing the healthy one.
if [ "$owner_scope" = "superseded" ]; then
  completion_timeout_seconds=${SUPERSEDED_RUN_COMPLETION_TIMEOUT_SECONDS:-420}
else
  completion_timeout_seconds=${SUPERSEDED_RUN_COMPLETION_TIMEOUT_SECONDS:-$timeout_seconds}
fi
if [[ ! "$poll_seconds" =~ ^[0-9]+$ ||
  ! "$timeout_seconds" =~ ^[0-9]+$ ||
  ! "$completion_timeout_seconds" =~ ^[0-9]+$ ]]; then
  echo "superseded run polling values must be non-negative integers" >&2
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
            .path == ".github/workflows/runner-image.yml" or
            .path == ".github/workflows/ci.yml"
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
        | [.id, .name, .status, .event, .head_sha, .html_url]
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
    if $cancel_selected_runs; then
      echo "::warning::failed to discover ${selected_runs_label}; continuing without cancellation: ${discovered_runs}" >&2
      exit 0
    fi
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

if [ "$assert_idle" = "true" ]; then
  echo "::error::A runner owner appeared while closed-PR cleanup held the namespace lifecycle lock:" >&2
  printf '%s\n' "$selected_runs" >&2
  exit 1
fi

if $cancel_selected_runs; then
  echo "Cancelling ${selected_runs_label} for PR #${pr_number}:"
else
  echo "Awaiting ${selected_runs_label} for PR #${pr_number}:"
fi
printf '%s\n' "$selected_runs"

run_ids=()
while IFS= read -r run_record; do
  run_id=${run_record%%$'\t'*}
  if $cancel_selected_runs; then
    # A regular cancellation is not an ownership handoff: GitHub may continue
    # always()-guarded jobs after accepting it. Force-cancel the strictly
    # selected old owner, then retain the terminal-state barrier below.
    if ! cancel_error=$(
      gh api --method POST \
        "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/force-cancel" 2>&1
    ); then
      echo "::warning::failed to cancel ${selected_run_label} ${run_id}; continuing without cancellation: ${cancel_error}" >&2
      continue
    fi
  fi
  run_ids+=("$run_id")
done <<<"$selected_runs"

if $cancel_selected_runs && [ "${#run_ids[@]}" -eq 0 ]; then
  echo "All ${selected_runs_label} failed cancellation; continuing without a terminal-state barrier."
  exit 0
fi

started_at=$SECONDS
while true; do
  pending_runs=()
  for run_id in "${run_ids[@]}"; do
    if ! current_status=$(
      gh api --method GET \
        "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}" \
        --jq '.status' 2>&1
    ); then
      if $cancel_selected_runs; then
        echo "::warning::failed to query ${selected_run_label} ${run_id}; continuing without a terminal-state barrier: ${current_status}" >&2
        exit 0
      fi
      echo "failed to query ${selected_run_label} ${run_id}: ${current_status}" >&2
      exit 1
    fi
    if [ "$current_status" != "completed" ]; then
      pending_runs+=("${run_id}:${current_status}")
    fi
  done

  if [ "${#pending_runs[@]}" -eq 0 ]; then
    echo "All ${selected_runs_label} completed before ${completion_boundary}."
    exit 0
  fi

  if ((SECONDS - started_at >= completion_timeout_seconds)); then
    echo "::error::Timed out after ${completion_timeout_seconds}s waiting for ${selected_runs_label} to complete: ${pending_runs[*]}" >&2
    exit 1
  fi

  echo "Waiting for ${selected_runs_label}: ${pending_runs[*]}"
  sleep "$poll_seconds"
done
