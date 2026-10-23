#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/cancel-superseded-merge-group-runs.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
fake_bin="${tmp_dir}/bin"
mkdir -p "$fake_bin"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

cat >"${fake_bin}/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$MOCK_GH_LOG"

endpoint=""
method="GET"
include_response=false
status_filter=""
previous=""
for argument in "$@"; do
  case "$previous" in
    --method) method=$argument ;;
  esac
  case "$argument" in
    --include|-i) include_response=true ;;
    repos/*) endpoint=$argument ;;
    status=*) status_filter=${argument#status=} ;;
  esac
  previous=$argument
done

case "$endpoint" in
  repos/okou-ai/okou/pulls/42)
    if [ "${MOCK_PR_LOOKUP_FAILURE:-0}" = "1" ]; then
      echo 'gh: failed to resolve PR head (HTTP 500)' >&2
      exit 1
    fi
    printf 'feature/safe-shared-runner\tokou-ai/okou\n'
    ;;
  repos/okou-ai/okou/actions/runs)
    if [ "${MOCK_DISCOVERY_FAILURE_STATUS:-}" = "$status_filter" ]; then
      echo 'gh: failed to list workflow runs (HTTP 500)' >&2
      exit 1
    fi
    if [ "${MOCK_NO_TARGETS:-0}" = "1" ]; then
      printf '[{"workflow_runs":[]}]\n'
      exit 0
    fi
    if [ "${MOCK_STATUS_TRANSITION:-0}" = "1" ] && [ "$status_filter" = "queued" ]; then
      queued_query_count=0
      if [ -f "$MOCK_QUEUED_QUERY_COUNT" ]; then
        queued_query_count=$(cat "$MOCK_QUEUED_QUERY_COUNT")
      fi
      queued_query_count=$((queued_query_count + 1))
      printf '%s\n' "$queued_query_count" >"$MOCK_QUEUED_QUERY_COUNT"
      if [ "$queued_query_count" -ge 2 ]; then
        cat <<'JSON'
[{"workflow_runs":[
  {"id":125,"name":"Runner Image","status":"queued","event":"merge_group","head_sha":"old-transitioning","head_branch":"gh-readonly-queue/main/pr-42-old-transitioning","path":".github/workflows/runner-image.yml","pull_requests":[],"html_url":"https://example.test/125"}
]}]
JSON
      else
        printf '[{"workflow_runs":[]}]\n'
      fi
      exit 0
    fi
    if [ "$status_filter" != "in_progress" ]; then
      printf '[{"workflow_runs":[]}]\n'
      exit 0
    fi
    cat <<'JSON'
[{"workflow_runs":[
  {"id":100,"name":"Turbo","status":"in_progress","event":"merge_group","head_sha":"old-a","head_branch":"gh-readonly-queue/main/pr-42-old-a","path":".github/workflows/turbo.yml","pull_requests":[],"html_url":"https://example.test/100"},
  {"id":110,"name":"Crates","status":"in_progress","event":"pull_request","head_sha":"old-b","head_branch":"feature/safe-shared-runner","head_repository":{"full_name":"okou-ai/okou"},"path":".github/workflows/crates.yml","pull_requests":[],"html_url":"https://example.test/110"},
  {"id":115,"name":"Turbo","status":"in_progress","event":"pull_request","head_sha":"old-branch-collision","head_branch":"feature/safe-shared-runner","head_repository":{"full_name":"fork/vm0"},"path":".github/workflows/turbo.yml","pull_requests":[],"html_url":"https://example.test/115"},
  {"id":120,"name":"Runner Image","status":"in_progress","event":"merge_group","head_sha":"old-c","head_branch":"gh-readonly-queue/main/pr-42-old-c","path":".github/workflows/runner-image.yml","pull_requests":[],"html_url":"https://example.test/120"},
  {"id":130,"name":"Turbo","status":"in_progress","event":"merge_group","head_sha":"old-d","head_branch":"gh-readonly-queue/main/pr-99-old-d","path":".github/workflows/turbo.yml","pull_requests":[],"html_url":"https://example.test/130"},
  {"id":140,"name":"Security","status":"in_progress","event":"merge_group","head_sha":"old-e","head_branch":"gh-readonly-queue/main/pr-42-old-e","path":".github/workflows/security.yml","pull_requests":[],"html_url":"https://example.test/140"},
  {"id":190,"name":"Turbo","status":"in_progress","event":"merge_group","head_sha":"current-sha","head_branch":"gh-readonly-queue/main/pr-42-current","path":".github/workflows/turbo.yml","pull_requests":[],"html_url":"https://example.test/190"},
  {"id":300,"name":"Turbo","status":"in_progress","event":"merge_group","head_sha":"newer-sha","head_branch":"gh-readonly-queue/main/pr-42-newer","path":".github/workflows/turbo.yml","pull_requests":[],"html_url":"https://example.test/300"}
]}]
JSON
    ;;
  repos/okou-ai/okou/actions/runs/*/force-cancel)
    [ "$method" = "POST" ] || exit 1
    run_id=${endpoint%/force-cancel}
    run_id=${run_id##*/}
    printf '%s\n' "$run_id" >>"$MOCK_CANCEL_LOG"
    case " ${MOCK_CANCEL_FAILURE_RUN_IDS:-} " in
      *" $run_id "*)
        http_status=${MOCK_CANCEL_FAILURE_HTTP_STATUS:-500}
        if $include_response; then
          printf 'HTTP/2.0 %s\nContent-Type: application/json\n\n' "$http_status"
        fi
        if [ "$http_status" = "409" ]; then
          echo '{"message":"Cannot cancel a workflow run that is not in progress.","status":"409"}'
        fi
        echo "gh: Failed to cancel workflow run (HTTP ${http_status})" >&2
        exit 1
        ;;
    esac
    ;;
  repos/okou-ai/okou/actions/runs/*)
    run_id=${endpoint##*/}
    case " ${MOCK_RUN_STATUS_FAILURE_RUN_IDS:-} " in
      *" $run_id "*)
        echo 'gh: failed to query workflow run (HTTP 500)' >&2
        exit 1
        ;;
    esac
    if [ "${MOCK_INVALID_STATUS:-0}" = "1" ]; then
      printf 'null\n'
    elif [ "${MOCK_DELAY_COMPLETION:-0}" = "1" ] && [ ! -f "$MOCK_RUNS_RELEASED" ]; then
      printf 'in_progress\n'
    else
      printf 'completed\n'
    fi
    ;;
  *)
    echo "unexpected gh endpoint: ${endpoint}" >&2
    exit 1
    ;;
esac
SH

cat >"${fake_bin}/sleep" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$1" >>"$MOCK_SLEEP_LOG"
touch "$MOCK_RUNS_RELEASED"
SH
chmod +x "${fake_bin}/gh" "${fake_bin}/sleep"

run_cancel() {
  env -i \
    PATH="${fake_bin}:$PATH" \
    HOME="${HOME:-/tmp}" \
    GH_TOKEN=test-token \
    GITHUB_REPOSITORY=okou-ai/okou \
    GITHUB_RUN_ID=200 \
    GITHUB_SHA=current-sha \
    MERGE_GROUP_HEAD_REF=gh-readonly-queue/main/pr-42-current \
    MOCK_GH_LOG="${tmp_dir}/gh.log" \
    MOCK_CANCEL_LOG="${tmp_dir}/cancel.log" \
    MOCK_SLEEP_LOG="${tmp_dir}/sleep.log" \
    MOCK_RUNS_RELEASED="${tmp_dir}/runs-released" \
    MOCK_QUEUED_QUERY_COUNT="${tmp_dir}/queued-query-count" \
    SUPERSEDED_RUN_POLL_SECONDS=0 \
    SUPERSEDED_RUN_TIMEOUT_SECONDS=10 \
    "$@" \
    bash "$script"
}

run_closed_pr_cleanup() {
  env -i \
    PATH="${fake_bin}:$PATH" \
    HOME="${HOME:-/tmp}" \
    GH_TOKEN=test-token \
    GITHUB_REPOSITORY=okou-ai/okou \
    GITHUB_RUN_ID=400 \
    PR_NUMBER=42 \
    RUNNER_OWNER_SCOPE=closed-pr-cleanup \
    MOCK_GH_LOG="${tmp_dir}/gh.log" \
    MOCK_CANCEL_LOG="${tmp_dir}/cancel.log" \
    MOCK_SLEEP_LOG="${tmp_dir}/sleep.log" \
    MOCK_RUNS_RELEASED="${tmp_dir}/runs-released" \
    MOCK_QUEUED_QUERY_COUNT="${tmp_dir}/queued-query-count" \
    SUPERSEDED_RUN_POLL_SECONDS=0 \
    SUPERSEDED_RUN_TIMEOUT_SECONDS=10 \
    "$@" \
    bash "$script"
}

: >"${tmp_dir}/gh.log"
: >"${tmp_dir}/cancel.log"
: >"${tmp_dir}/sleep.log"
output=$(run_cancel MOCK_RUN_STATUS_FAILURE_RUN_IDS='100 110 120')
grep -q "Requested cancellation of superseded CI runs" <<<"$output" ||
  fail "expected cancellation requests without a completion claim"
cancelled_runs=$(cat "${tmp_dir}/cancel.log")
[ "$cancelled_runs" = $'100\n110\n120' ] ||
  fail "expected only older same-PR consumer runs to be cancelled, got: ${cancelled_runs}"
[ ! -s "${tmp_dir}/sleep.log" ] ||
  fail "superseded runs must not poll after cancellation"
if grep -Eq 'api --method GET repos/okou-ai/okou/actions/runs/[0-9]+ ' "${tmp_dir}/gh.log"; then
  fail "superseded runs must not read individual statuses after cancellation"
fi

: >"${tmp_dir}/gh.log"
: >"${tmp_dir}/cancel.log"
: >"${tmp_dir}/sleep.log"
rm -f "${tmp_dir}/runs-released"
output=$(run_closed_pr_cleanup MOCK_DELAY_COMPLETION=1)
grep -q "All active runner-owner CI runs completed before closed-PR resource cleanup starts" <<<"$output" ||
  fail "expected closed-PR cleanup to await every active runner owner"
[ ! -s "${tmp_dir}/cancel.log" ] ||
  fail "closed-PR cleanup must not cancel active required checks"
grep -q "Waiting for active runner-owner CI runs" <<<"$output" ||
  fail "closed-PR cleanup must retain an explicit terminal-state barrier"
[ "$(wc -l <"${tmp_dir}/sleep.log")" -eq 1 ] ||
  fail "closed-PR cleanup must wait for active owners to finish naturally"

: >"${tmp_dir}/cancel.log"
: >"${tmp_dir}/sleep.log"
if run_closed_pr_cleanup RUNNER_OWNER_ASSERT_IDLE=true \
  >"${tmp_dir}/assert-idle.out" 2>"${tmp_dir}/assert-idle.err"; then
  fail "locked cleanup must abort when a late owner appears"
fi
grep -q "appeared while closed-PR cleanup held the namespace lifecycle lock" \
  "${tmp_dir}/assert-idle.err" ||
  fail "locked cleanup must explain the late-owner handoff"
[ ! -s "${tmp_dir}/cancel.log" ] ||
  fail "locked cleanup must not cancel the late owner"
[ ! -s "${tmp_dir}/sleep.log" ] ||
  fail "locked cleanup must release its host lock instead of awaiting the late owner"

: >"${tmp_dir}/cancel.log"
: >"${tmp_dir}/sleep.log"
rm -f "${tmp_dir}/runs-released"
if run_closed_pr_cleanup \
  MOCK_DELAY_COMPLETION=1 \
  SUPERSEDED_RUN_TIMEOUT_SECONDS=0 \
  >"${tmp_dir}/closed-timeout.out" 2>"${tmp_dir}/closed-timeout.err"; then
  fail "closed-PR cleanup must fail closed when an active owner outlives the barrier"
fi
[ ! -s "${tmp_dir}/cancel.log" ] ||
  fail "timed-out closed-PR cleanup must not cancel the active owner"
[ ! -s "${tmp_dir}/sleep.log" ] ||
  fail "zero-timeout ownership barrier must fail before polling"

: >"${tmp_dir}/gh.log"
: >"${tmp_dir}/cancel.log"
rm -f "${tmp_dir}/queued-query-count"
output=$(run_cancel MOCK_STATUS_TRANSITION=1)
cancelled_runs=$(cat "${tmp_dir}/cancel.log")
[ "$cancelled_runs" = $'100\n110\n120\n125' ] ||
  fail "expected a run that changed status during discovery to be cancelled, got: ${cancelled_runs}"
[ "$(cat "${tmp_dir}/queued-query-count")" -ge 3 ] ||
  fail "expected discovery to rescan until the active run set stabilized"

: >"${tmp_dir}/gh.log"
: >"${tmp_dir}/cancel.log"
output=$(run_cancel MOCK_NO_TARGETS=1)
grep -q "No superseded CI runs found" <<<"$output" ||
  fail "expected empty active-run set to exit cleanly"
[ ! -s "${tmp_dir}/cancel.log" ] ||
  fail "empty active-run set must not cancel anything"

if run_cancel MERGE_GROUP_HEAD_REF=gh-readonly-queue/main/no-pr >/dev/null 2>&1; then
  fail "invalid merge-group ref must fail closed"
fi

: >"${tmp_dir}/gh.log"
: >"${tmp_dir}/cancel.log"
: >"${tmp_dir}/sleep.log"
rm -f "${tmp_dir}/runs-released"
if run_cancel MOCK_CANCEL_FAILURE_RUN_IDS=100 \
  >"${tmp_dir}/cancel-failure.out" 2>"${tmp_dir}/cancel-failure.err"; then
  fail "non-conflict cancellation failure must stop the handoff"
fi
grep -q 'failed to cancel superseded run 100' "${tmp_dir}/cancel-failure.err" ||
  fail "expected an explicit cancellation failure"
[ "$(cat "${tmp_dir}/cancel.log")" = 100 ] ||
  fail "no producer request may follow an unconfirmed consumer cancellation"

# A concurrent cancellation can return 409 while status reads still fail.
# Continue with the remaining requests without reading, waiting or retrying.
: >"${tmp_dir}/gh.log"
: >"${tmp_dir}/cancel.log"
: >"${tmp_dir}/sleep.log"
rm -f "${tmp_dir}/runs-released"
output=$(run_cancel MOCK_CANCEL_FAILURE_RUN_IDS=100 MOCK_CANCEL_FAILURE_HTTP_STATUS=409 \
  MOCK_RUN_STATUS_FAILURE_RUN_IDS='100 110 120')
grep -q "Requested cancellation of superseded CI runs" <<<"$output" ||
  fail "cancellation conflict must continue without completion checks"
[ ! -s "${tmp_dir}/sleep.log" ] ||
  fail "cancellation conflict must not wait for completion"
[ "$(cat "${tmp_dir}/cancel.log")" = $'100\n110\n120' ] ||
  fail "conflict recovery must preserve request ordering without replaying cancellation"
if grep -Eq 'api --method GET repos/okou-ai/okou/actions/runs/[0-9]+ ' "${tmp_dir}/gh.log"; then
  fail "cancellation conflict must not read individual statuses"
fi

: >"${tmp_dir}/gh.log"
: >"${tmp_dir}/cancel.log"
: >"${tmp_dir}/sleep.log"
rm -f "${tmp_dir}/runs-released"
if run_closed_pr_cleanup MOCK_INVALID_STATUS=1 >"${tmp_dir}/invalid.out" 2>"${tmp_dir}/invalid.err"; then
  fail "unknown status must stop closed-PR cleanup"
fi
[ ! -s "${tmp_dir}/cancel.log" ] || fail "closed-PR cleanup must not cancel owners"

: >"${tmp_dir}/gh.log"
: >"${tmp_dir}/cancel.log"
if run_cancel MOCK_PR_LOOKUP_FAILURE=1 >"${tmp_dir}/lookup.out" 2>"${tmp_dir}/lookup.err"; then
  fail "PR lookup failure must stop the handoff"
fi
[ ! -s "${tmp_dir}/cancel.log" ] ||
  fail "a PR lookup API failure must not attempt cancellation"

: >"${tmp_dir}/gh.log"
: >"${tmp_dir}/cancel.log"
if run_cancel MOCK_DISCOVERY_FAILURE_STATUS=queued >"${tmp_dir}/discovery.out" 2>"${tmp_dir}/discovery.err"; then
  fail "discovery failure must stop the handoff"
fi
[ ! -s "${tmp_dir}/cancel.log" ] ||
  fail "a run discovery API failure must not attempt cancellation"

: >"${tmp_dir}/gh.log"
: >"${tmp_dir}/cancel.log"
: >"${tmp_dir}/sleep.log"
if run_closed_pr_cleanup MOCK_RUN_STATUS_FAILURE_RUN_IDS=100 >"${tmp_dir}/status.out" 2>"${tmp_dir}/status.err"; then
  fail "unreadable owner status must stop closed-PR cleanup"
fi
[ ! -s "${tmp_dir}/sleep.log" ] ||
  fail "an API status failure must stop before polling"
[ ! -s "${tmp_dir}/cancel.log" ] || fail "closed-PR cleanup must not cancel owners"

if run_closed_pr_cleanup MOCK_DISCOVERY_FAILURE_STATUS=queued >/dev/null 2>&1; then
  fail "closed-PR cleanup must fail closed when run discovery fails"
fi

echo "cancel-superseded-merge-group-runs tests passed"
