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
  echo "failed to resolve PR #${pr_number} head: ${pr_head}" >&2
  exit 1
fi
IFS=$'\t' read -r pr_head_ref pr_head_repository <<<"$pr_head"
if [ -z "$pr_head_ref" ] || [ -z "$pr_head_repository" ]; then
  echo "failed to resolve head repository and ref for PR #${pr_number}" >&2
  exit 1
fi

poll_seconds=${SUPERSEDED_RUN_POLL_SECONDS:-2}
timeout_seconds=${SUPERSEDED_RUN_TIMEOUT_SECONDS:-180}
completion_timeout_seconds=${SUPERSEDED_RUN_COMPLETION_TIMEOUT_SECONDS:-$timeout_seconds}
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

# Closed-PR cleanup retains its completion barrier. Superseded runs return
# after cancellation requests without reading their individual statuses.
started_at=$SECONDS

read_run_status() {
  local run_id=$1 current_status
  if ! current_status=$(gh api --method GET \
    "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}" --jq '.status' 2>&1); then
    echo "failed to query ${selected_run_label} ${run_id}: ${current_status}" >&2
    return 1
  fi
  case "$current_status" in
    completed|queued|in_progress|pending|waiting|requested) printf '%s\n' "$current_status" ;;
    *) echo "invalid status for ${selected_run_label} ${run_id}: ${current_status}" >&2; return 1 ;;
  esac
}

process_phase() {
  local records=$1 phase_label=$2 run_record run_id cancel_error cancel_status current_status
  local run_ids=() pending_runs=()
  [ -n "$records" ] || return 0

  while IFS= read -r run_record; do
    run_id=${run_record%%$'\t'*}
    if $cancel_selected_runs; then
      # Stop always()-guarded jobs as well as ordinary steps. A 409 may race
      # with cancellation elsewhere; do not read or await the run afterward.
      if ! cancel_error=$(gh api --method POST \
        "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/force-cancel" --include 2>&1); then
        cancel_status=$(awk '/^HTTP\// { print $2; exit }' <<<"$cancel_error")
        if [ "$cancel_status" != "409" ]; then
          echo "failed to cancel ${selected_run_label} ${run_id}: ${cancel_error}" >&2
          return 1
        fi
        echo "Cancellation conflict for ${selected_run_label} ${run_id}; continuing without waiting."
      fi
    fi
    run_ids+=("$run_id")
  done <<<"$records"

  if $cancel_selected_runs; then
    return 0
  fi

  while true; do
    pending_runs=()
    for run_id in "${run_ids[@]}"; do
      current_status=$(read_run_status "$run_id")
      if [ "$current_status" != "completed" ]; then
        pending_runs+=("${run_id}:${current_status}")
      fi
    done
    if [ "${#pending_runs[@]}" -eq 0 ]; then
      echo "All ${phase_label} completed."
      return 0
    fi
    if ((SECONDS - started_at >= completion_timeout_seconds)); then
      echo "::error::Timed out after ${completion_timeout_seconds}s waiting for ${selected_runs_label} to complete: ${pending_runs[*]}" >&2
      return 1
    fi
    echo "Waiting for ${selected_runs_label} (${phase_label}): ${pending_runs[*]}"
    sleep "$poll_seconds"
  done
}

if $cancel_selected_runs; then
  consumers=$(awk -F '\t' '$7 != ".github/workflows/runner-image.yml"' <<<"$selected_runs")
  producers=$(awk -F '\t' '$7 == ".github/workflows/runner-image.yml"' <<<"$selected_runs")
  process_phase "$consumers" "superseded runner consumers"
  process_phase "$producers" "superseded runner image producers"
  echo "Requested cancellation of ${selected_runs_label}; continuing without waiting for completion."
else
  process_phase "$selected_runs" "$selected_runs_label"
  echo "All ${selected_runs_label} completed before ${completion_boundary}."
fi
