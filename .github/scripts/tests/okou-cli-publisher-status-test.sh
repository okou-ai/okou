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
    case "$MOCK_CASE" in
      skipped|failed|success|queued)
        case "$MOCK_CASE" in
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
    if [[ "$MOCK_CASE" == none ]]; then
      printf '%s\n' '{"workflow_runs":[]}'
    else
      status=in_progress
      [[ "$MOCK_CASE" != terminal_no_job ]] || status=completed
      jq -nc --arg sha "$ARTIFACT_SHA" --arg event "$GITHUB_EVENT_NAME" \
        --arg status "$status" \
        '{workflow_runs:[{id:11,head_sha:$sha,event:$event,created_at:"2026-09-23T00:00:00Z",status:$status}]}'
    fi
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
