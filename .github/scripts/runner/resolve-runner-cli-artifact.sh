#!/usr/bin/env bash
# Resolve Runner Image's private CLI input for host E2E; downloads are owned by
# actions/download-artifact and verified with verify-okou-cli-artifact.sh.
# Required: REPO, LOOKUP_SHA (PR head or push/queue SHA), EVENT_NAME,
# HEAD_BRANCH, GH_TOKEN and GITHUB_OUTPUT. Requires gh, jq, timeout and date.
# Optional: TIMEOUT_SECONDS=900, POLL_SECONDS=30. Emits run-id and artifact-id.
set -euo pipefail

fail() { echo "::error::Runner CLI input: $*" >&2; exit 1; }
for name in REPO LOOKUP_SHA EVENT_NAME HEAD_BRANCH GH_TOKEN GITHUB_OUTPUT; do
  [ -n "${!name:-}" ] || fail "missing $name"
done
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "invalid repository"
[[ "$LOOKUP_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "invalid producer lookup SHA"
case "$EVENT_NAME" in pull_request|push|merge_group) ;; *) fail "unsupported event" ;; esac
timeout_seconds=${TIMEOUT_SECONDS:-900}
poll_seconds=${POLL_SECONDS:-30}
[[ "$timeout_seconds" =~ ^[1-9][0-9]*$ && "$poll_seconds" =~ ^[1-9][0-9]*$ ]] || fail "invalid wait budget"
deadline=$(( $(date +%s) + timeout_seconds ))

api() { timeout --kill-after=5s 45s gh api "$@"; }
wait_for_producer() {
  if (( $(date +%s) + poll_seconds >= deadline )); then
    fail "timed out waiting for the selected producer"
  fi
  sleep "$poll_seconds"
}

while (( $(date +%s) < deadline )); do
  runs=$(api "repos/${REPO}/actions/workflows/runner-image.yml/runs" --method GET \
    -f head_sha="$LOOKUP_SHA" -f event="$EVENT_NAME" -f per_page=100)
  jq -e '.total_count <= 100 and (.workflow_runs | type == "array")' <<<"$runs" >/dev/null || fail "incomplete workflow discovery"
  run=$(jq -c --arg sha "$LOOKUP_SHA" --arg event "$EVENT_NAME" --arg branch "$HEAD_BRANCH" '
    [.workflow_runs[] | select(.head_sha == $sha and .event == $event and .head_branch == $branch)]
    | sort_by(.id) | last // empty
  ' <<<"$runs")
  if [ -z "$run" ]; then wait_for_producer; continue; fi
  jq -e --arg repo "$REPO" '
    .repository.full_name == $repo and .head_repository.full_name == $repo and
    .path == ".github/workflows/runner-image.yml" and
    (.id | type == "number" and floor == . and . > 0)
  ' <<<"$run" >/dev/null || fail "producer workflow identity mismatch"
  run_id=$(jq -r .id <<<"$run")

  jobs=$(api "repos/${REPO}/actions/runs/${run_id}/jobs?filter=all&per_page=100")
  jq -e '.total_count <= 100 and (.jobs | type == "array")' <<<"$jobs" >/dev/null || fail "incomplete prepare-job discovery"
  job=$(jq -c '[.jobs[] | select(.name == "prepare")] | sort_by(.id) | last // empty' <<<"$jobs")
  if [ -z "$job" ]; then
    [ "$(jq -r .status <<<"$run")" != completed ] || fail "completed producer has no prepare job"
    wait_for_producer; continue
  fi
  jq -e --arg sha "$LOOKUP_SHA" --argjson run "$run_id" '
    .run_id == $run and .head_sha == $sha and
    (.id | type == "number" and floor == . and . > 0) and
    (.run_attempt | type == "number" and floor == . and . > 0)
  ' <<<"$job" >/dev/null || fail "prepare-job identity mismatch"
  if [ "$(jq -r .status <<<"$job")" != completed ]; then wait_for_producer; continue; fi
  [ "$(jq -r .conclusion <<<"$job")" = success ] || fail "selected prepare job failed or was cancelled (run ${run_id})"
  # A consumer-only rerun can increment the workflow attempt without rerunning
  # prepare. Bind to the latest actual prepare job, never the consumer attempt.
  attempt=$(jq -r .run_attempt <<<"$job")
  artifact_name="runner-cli-${run_id}-${attempt}"
  artifacts=$(api "repos/${REPO}/actions/runs/${run_id}/artifacts?name=${artifact_name}&per_page=100")
  jq -e '.total_count <= 100 and (.artifacts | type == "array")' <<<"$artifacts" >/dev/null || fail "incomplete artifact discovery"
  matches=$(jq -c --arg name "$artifact_name" '[.artifacts[] | select(.name == $name)]' <<<"$artifacts")
  count=$(jq length <<<"$matches")
  if [ "$count" = 0 ]; then wait_for_producer; continue; fi
  [ "$count" = 1 ] || fail "ambiguous producer artifact"
  jq -e --arg sha "$LOOKUP_SHA" --argjson run "$run_id" '
    .[0] | .expired == false and .workflow_run.id == $run and
    .workflow_run.head_sha == $sha and
    (.id | type == "number" and floor == . and . > 0)
  ' <<<"$matches" >/dev/null || fail "expired artifact or producer provenance mismatch"

  # Recheck the latest actual prepare job before exposing its immutable ID.
  latest=$(api "repos/${REPO}/actions/runs/${run_id}/jobs?filter=all&per_page=100")
  jq -e --argjson job "$job" '
    .total_count <= 100 and
    ([.jobs[] | select(.name == "prepare")] | sort_by(.id) | last) == $job
  ' <<<"$latest" >/dev/null || { wait_for_producer; continue; }
  {
    echo "run-id=$run_id"
    echo "artifact-id=$(jq -r '.[0].id' <<<"$matches")"
    echo "producer-attempt=$attempt"
  } >>"$GITHUB_OUTPUT"
  echo "Resolved private Runner CLI input from run ${run_id}, prepare attempt ${attempt}"
  exit 0
done
fail "timed out waiting for Runner CLI input"
