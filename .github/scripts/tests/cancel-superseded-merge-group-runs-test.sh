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
    printf 'feature/safe-shared-runner\tokou-ai/okou\t%s\n' "${MOCK_PR_STATE:-closed}"
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
    echo 'gh: run status has not converged (HTTP 500)' >&2
    exit 1
    ;;
  *)
    echo "unexpected gh endpoint: ${endpoint}" >&2
    exit 1
    ;;
esac
SH

chmod +x "${fake_bin}/gh"

run_cancel() {
  env -i \
    PATH="${fake_bin}:$PATH" \
    HOME="${HOME:-/tmp}" \
    GH_TOKEN=test-token \
    GITHUB_REPOSITORY=okou-ai/okou \
    GITHUB_RUN_ID=200 \
    GITHUB_SHA=current-sha \
    MERGE_GROUP_HEAD_REF=gh-readonly-queue/main/pr-42-current \
    MOCK_CANCEL_LOG="${tmp_dir}/cancel.log" \
    MOCK_QUEUED_QUERY_COUNT="${tmp_dir}/queued-query-count" \
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
    MOCK_CANCEL_LOG="${tmp_dir}/cancel.log" \
    MOCK_QUEUED_QUERY_COUNT="${tmp_dir}/queued-query-count" \
    SUPERSEDED_RUN_TIMEOUT_SECONDS=10 \
    "$@" \
    bash "$script"
}

: >"${tmp_dir}/cancel.log"
run_cancel >/dev/null
cancelled_runs=$(cat "${tmp_dir}/cancel.log")
[ "$cancelled_runs" = $'100\n110\n120' ] ||
  fail "expected only older same-PR consumer runs to be cancelled, got: ${cancelled_runs}"

# GitHub can reject cancellation as already finished while reads still expose
# an active run. The new merge group must continue after requesting cancellation.
: >"${tmp_dir}/cancel.log"
run_cancel MOCK_CANCEL_FAILURE_RUN_IDS=100 MOCK_CANCEL_FAILURE_HTTP_STATUS=409 \
  >/dev/null
[ "$(cat "${tmp_dir}/cancel.log")" = $'100\n110\n120' ] ||
  fail "a cancellation conflict must still allow the remaining cancellation requests"

: >"${tmp_dir}/cancel.log"
run_closed_pr_cleanup MOCK_CANCEL_FAILURE_RUN_IDS=100 MOCK_CANCEL_FAILURE_HTTP_STATUS=409 >/dev/null
[ "$(cat "${tmp_dir}/cancel.log")" = $'100\n110\n190\n300\n120' ] ||
  fail "closed-PR cleanup must request cancellation of every same-PR owner, consumers first"

: >"${tmp_dir}/cancel.log"
if run_closed_pr_cleanup MOCK_PR_STATE=open \
  >"${tmp_dir}/open-pr.out" 2>"${tmp_dir}/open-pr.err"; then
  fail "closed-PR cleanup must reject a reopened PR"
fi
[ ! -s "${tmp_dir}/cancel.log" ] ||
  fail "closed-PR cleanup must not cancel CI for an open PR"

: >"${tmp_dir}/cancel.log"
rm -f "${tmp_dir}/queued-query-count"
run_cancel MOCK_STATUS_TRANSITION=1 >/dev/null
cancelled_runs=$(cat "${tmp_dir}/cancel.log")
[ "$cancelled_runs" = $'100\n110\n120\n125' ] ||
  fail "expected a run that changed status during discovery to be cancelled, got: ${cancelled_runs}"
[ "$(cat "${tmp_dir}/queued-query-count")" -ge 3 ] ||
  fail "expected discovery to rescan until the active run set stabilized"

: >"${tmp_dir}/cancel.log"
output=$(run_cancel MOCK_NO_TARGETS=1)
grep -q "No superseded CI runs found" <<<"$output" ||
  fail "expected empty active-run set to exit cleanly"
[ ! -s "${tmp_dir}/cancel.log" ] ||
  fail "empty active-run set must not cancel anything"

if run_cancel MERGE_GROUP_HEAD_REF=gh-readonly-queue/main/no-pr >/dev/null 2>&1; then
  fail "invalid merge-group ref must fail closed"
fi

: >"${tmp_dir}/cancel.log"
if run_cancel MOCK_CANCEL_FAILURE_RUN_IDS=100 \
  >"${tmp_dir}/cancel-failure.out" 2>"${tmp_dir}/cancel-failure.err"; then
  fail "non-conflict cancellation failure must stop the handoff"
fi
grep -q 'failed to cancel superseded run 100' "${tmp_dir}/cancel-failure.err" ||
  fail "expected an explicit cancellation failure"
[ "$(cat "${tmp_dir}/cancel.log")" = 100 ] ||
  fail "no producer request may follow a failed consumer cancellation"

: >"${tmp_dir}/cancel.log"
if run_cancel MOCK_PR_LOOKUP_FAILURE=1 >"${tmp_dir}/lookup.out" 2>"${tmp_dir}/lookup.err"; then
  fail "PR lookup failure must stop the handoff"
fi
[ ! -s "${tmp_dir}/cancel.log" ] ||
  fail "a PR lookup API failure must not attempt cancellation"

: >"${tmp_dir}/cancel.log"
if run_cancel MOCK_DISCOVERY_FAILURE_STATUS=queued >"${tmp_dir}/discovery.out" 2>"${tmp_dir}/discovery.err"; then
  fail "discovery failure must stop the handoff"
fi
[ ! -s "${tmp_dir}/cancel.log" ] ||
  fail "a run discovery API failure must not attempt cancellation"

if run_closed_pr_cleanup MOCK_DISCOVERY_FAILURE_STATUS=queued >/dev/null 2>&1; then
  fail "closed-PR cleanup must fail closed when run discovery fails"
fi

echo "cancel-superseded-merge-group-runs tests passed"
