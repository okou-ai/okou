#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT
mkdir -p "$test_root/bin" "$test_root/output"

# Mock only GitHub's API boundary. The production helper still selects the
# workflow run, paginated deploy-cli job, and terminal conclusion itself.
cat > "$test_root/bin/gh" <<'MOCK_GH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == api ]]
case "$*" in
  *"/jobs?per_page=100"*)
    [[ "$*" == *"--paginate"* ]] || exit 90
    [[ "$*" =~ /runs/([0-9]+)/jobs ]] || exit 96
    run_id="${BASH_REMATCH[1]}"
    case "$MOCK_CASE" in
      skipped|failed|success|queued|older_active|older_success|all_skipped)
        job_case="$MOCK_CASE"
        case "$MOCK_CASE:$run_id" in
          older_active:11|older_success:11|all_skipped:*) job_case=skipped ;;
          older_active:10) job_case=queued ;;
          older_success:10) job_case=success ;;
        esac
        case "$job_case" in
          skipped) status=completed; conclusion=skipped ;;
          failed) status=completed; conclusion=failure ;;
          success) status=completed; conclusion=success ;;
          queued) status=queued; conclusion=null ;;
        esac
        jq -nc --arg name "$EXPECTED_JOB" --arg status "$status" \
          --arg conclusion "$conclusion" \
          '{id: 22, name: $name, status: $status,
            conclusion: (if $conclusion == "null" then null else $conclusion end)}'
        ;;
    esac
    ;;
  *"/workflows/"*"/runs?"*)
    [[ "$*" == *"head_sha=${ARTIFACT_SHA}"* ]] || exit 91
    [[ "$*" == *"event=${GITHUB_EVENT_NAME}"* ]] || exit 92
    [[ "$*" == *"/workflows/${EXPECTED_WORKFLOW}/runs?"* ]] || exit 93
    [[ "$MOCK_CASE" != api_error ]] || exit 94
    status=in_progress
    [[ "$MOCK_CASE" != terminal_no_job ]] || status=completed
    jq -nc --arg sha "$ARTIFACT_SHA" --arg event "$GITHUB_EVENT_NAME" \
      --arg status "$status" --arg mock_case "$MOCK_CASE" '
      ($mock_case == "older_active" or $mock_case == "older_success" or
        $mock_case == "all_skipped") as $multiple |
      {total_count: (if $mock_case == "none" then 0
        elif $mock_case == "truncated" then 2
        elif $multiple then 2 else 1 end),
       workflow_runs: (if $mock_case == "none" then [] else
         [{id:11,head_sha:$sha,event:$event,created_at:"2026-09-23T00:01:00Z",status:$status}] +
         (if $multiple then
           [{id:10,head_sha:$sha,event:$event,created_at:"2026-09-23T00:00:00Z",status:"in_progress"}]
          else [] end) end)}'
    ;;
  *) exit 95 ;;
esac
MOCK_GH

cat > "$test_root/bin/curl" <<'MOCK_CURL'
#!/usr/bin/env bash
exit 22
MOCK_CURL

cat > "$test_root/bin/sleep" <<'MOCK_SLEEP'
#!/usr/bin/env bash
exit 77
MOCK_SLEEP
chmod +x "$test_root/bin/gh" "$test_root/bin/curl" "$test_root/bin/sleep"

export PATH="$test_root/bin:$PATH"
ARTIFACT_SHA="$(printf 'a%.0s' {1..40})"
export ARTIFACT_SHA
export GITHUB_REPOSITORY=okou-ai/okou
export GH_TOKEN=fixture
export EXPECTED_JOB=deploy-cli
export EXPECTED_WORKFLOW=turbo.yml
export GITHUB_EVENT_NAME=pull_request

assert_status() {
  local mock_case=$1 expected=$2 actual
  actual=$(MOCK_CASE="$mock_case" bash "$SCRIPT_DIR/okou-cli-publisher-status.sh")
  [[ "$actual" == "$expected" ]] || {
    echo "FAIL: $mock_case: expected $expected, got $actual" >&2
    exit 1
  }
}

assert_status none pending
assert_status active_no_job pending
assert_status terminal_no_job unavailable
assert_status queued pending
assert_status success pending
assert_status skipped unavailable
assert_status failed unavailable
assert_status older_active pending
assert_status older_success pending
assert_status all_skipped unavailable
assert_status truncated pending

export GITHUB_EVENT_NAME=merge_group
assert_status skipped unavailable

export GITHUB_EVENT_NAME=push
export EXPECTED_JOB='deploy-and-test / deploy-cli'
export EXPECTED_WORKFLOW=staging.yml
assert_status skipped unavailable
assert_status success pending

# A terminal producer must let an optional image build continue without
# sleeping for the full 600-second artifact window.
export GITHUB_EVENT_NAME=pull_request
export EXPECTED_JOB=deploy-cli
export EXPECTED_WORKFLOW=turbo.yml
download_output=$(MOCK_CASE=skipped OUTPUT_DIR="$test_root/output" \
  ARTIFACT_REQUIRED=false CHECK_PUBLISHER_STATUS=true WAIT_SECONDS=600 \
  bash "$SCRIPT_DIR/download-okou-cli-artifact.sh")
grep -qx 'found=false' <<< "$download_output" || {
  echo "FAIL: terminal publisher did not allow a CLI-less image" >&2
  exit 1
}

# An active producer or API error must preserve the existing wait. The sleep
# mock stops the loop immediately, so this test never actually waits.
for mock_case in none queued api_error; do
  if MOCK_CASE="$mock_case" OUTPUT_DIR="$test_root/output" \
    ARTIFACT_REQUIRED=false CHECK_PUBLISHER_STATUS=true WAIT_SECONDS=600 \
    bash "$SCRIPT_DIR/download-okou-cli-artifact.sh" > "$test_root/download.log" 2>&1; then
    echo "FAIL: $mock_case skipped the artifact wait" >&2
    exit 1
  fi
  grep -q 'Waiting for CLI artifact:' "$test_root/download.log" || {
    echo "FAIL: $mock_case did not retain the artifact wait" >&2
    exit 1
  }
done

echo "okou CLI publisher status tests passed"
