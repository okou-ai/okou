#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
mkdir -p "$test_dir/bin"

fail() { echo "FAIL: $1" >&2; exit 1; }

cat >"$test_dir/bin/gh" <<'PY'
#!/usr/bin/env python3
import json, os, sys
from pathlib import Path

args = sys.argv[1:]
endpoint = next((a for a in args if a.startswith('repos/') or a == 'graphql'), '')
case = os.environ['MOCK_CASE']
base = Path(os.environ['MOCK_ROOT'])
with (base / 'gh.log').open('a') as f:
    f.write(' '.join(args) + '\n')

def respond(body, code=200, headers=''):
    print(f'HTTP/2.0 {code} Fixture\r\n{headers}\r\n' + json.dumps(body))
    if code >= 400:
        print(f'gh: fixture HTTP {code}', file=sys.stderr)
        sys.exit(1)

if endpoint == 'repos/okou-ai/okou/actions/runs/777/force-cancel':
    assert '--method' in args and args[args.index('--method') + 1] == 'POST'
    (base / 'cancelled').write_text(endpoint)
    if case == 'cancel-denied': respond({}, 403)
    if case == 'cancel-conflict': respond({}, 409)
    respond({}, 202)
elif endpoint == 'repos/okou-ai/okou/actions/runs/777':
    count_file = base / 'run-count'
    count = int(count_file.read_text()) + 1 if count_file.exists() else 1
    count_file.write_text(str(count))
    if case == 'initial-run-rate-limited' and count == 1: respond({}, 429, 'Retry-After: 1\r\n')
    if case in ['authority-restored-during-run-retry', 'authority-restored-during-run-transient']:
        if count == 2:
            if case.endswith('-retry'): respond({}, 429, 'Retry-After: 60\r\n')
            respond({}, 503)
        if count > 2: (base / 'ownership-restored').touch()
    event = os.environ['GITHUB_EVENT_NAME']
    branch = os.environ['GITHUB_REF'].removeprefix('refs/heads/') if event == 'merge_group' else os.environ['GITHUB_HEAD_REF']
    run = {'id':777, 'run_attempt':1, 'event':event, 'status':'in_progress',
           'head_sha':os.environ['LOOKUP_SHA'], 'head_branch':branch,
           'repository':{'full_name':'okou-ai/okou'}, 'head_repository':{'full_name':'okou-ai/okou'},
           'path':'.github/workflows/turbo.yml'}
    if case.startswith('crates-'): run['path'] = '.github/workflows/crates.yml'
    if case == 'wrong-workflow': run['path'] = '.github/workflows/runner-image.yml'
    if case == 'other-repository': run['repository']['full_name'] = 'other/repo'
    if case == 'other-pr': run['head_branch'] = 'gh-readonly-queue/main/pr-999-' + 'a'*40
    if case == 'wrong-sha': run['head_sha'] = 'c'*40
    if case == 'new-attempt' or (case == 'attempt-changed' and count > 1): run['run_attempt'] = 2
    if case == 'invalid-status': run['status'] = 'unknown'
    if case == 'cancel-conflict' and (base / 'cancelled').exists():
        run.update(status='completed', conclusion='cancelled')
    respond(run)
elif '/git/ref/' in endpoint:
    count_file = base / 'ref-count'
    count = int(count_file.read_text()) + 1 if count_file.exists() else 1
    count_file.write_text(str(count))
    if case == 'owner-restored' and count == 1: respond({}, 404)
    if case == 'ref-denied': respond({}, 403)
    if case in ['authority-restored-during-run-retry', 'authority-restored-during-run-transient'] and not (base / 'ownership-restored').exists(): respond({}, 404)
    if case == 'final-ref-rate-limited' and count == 2: respond({}, 429, 'Retry-After: 1\r\n')
    if case in ['missing-ref', 'crates-missing-ref', 'attempt-changed', 'cancel-denied', 'cancel-conflict', 'no-interruption', 'near-deadline', 'initial-run-rate-limited', 'final-ref-rate-limited']: respond({}, 404)
    if case == 'rate-limited':
        flag = base / 'rate-limit'
        if not flag.exists():
            flag.touch()
            respond({}, 429, 'Retry-After: 1\r\n')
        respond({}, 404)
    sha = 'c'*40 if case == 'changed-ref' else os.environ['GITHUB_SHA']
    if case == 'malformed-ref': sha = 'invalid'
    respond({'ref':os.environ['GITHUB_REF'], 'object':{'type':'commit','sha':sha}})
elif endpoint == 'graphql':
    state = 'CLOSED' if case == 'closed-pr' else 'OPEN'
    sha = 'c'*40 if case in ['changed-pr', 'crates-changed-pr'] else os.environ['LOOKUP_SHA']
    body = {'data':{'repository':{'pullRequest':{'state':state,'headRefOid':sha,
             'isInMergeQueue':case == 'queued-pr','headRepository':{'nameWithOwner':'okou-ai/okou'}}}}}
    if case == 'pr-query-error': body = {'errors':[{'message':'fixture'}]}
    respond(body)
elif '/actions/artifacts?' in endpoint:
    respond({'artifacts':[]})
elif '/actions/workflows/runner-image.yml/runs?' in endpoint:
    conclusion = 'failure' if case == 'producer-failed' else 'cancelled'
    respond({'workflow_runs':[{'id':42,'status':'completed','conclusion':conclusion,
             'created_at':'2026-10-12T08:00:00Z','html_url':'https://example.test/run/42'}]})
else:
    print('unexpected fixture API operation: ' + endpoint, file=sys.stderr)
    sys.exit(64)
PY

cat >"$test_dir/bin/date" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[ "$*" = '+%s' ]
cat "$MOCK_ROOT/clock"
SH
cat >"$test_dir/bin/sleep" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ -f "$MOCK_ROOT/cancelled" ] && [ "$MOCK_CASE" != no-interruption ]; then
  kill -TERM "$PPID"
  exit 0
fi
now=$(cat "$MOCK_ROOT/clock")
echo "$((now + $1))" >"$MOCK_ROOT/clock"
SH
chmod +x "$test_dir/bin/gh" "$test_dir/bin/date" "$test_dir/bin/sleep"

build_sha=$(printf 'a%.0s' {1..40})
pr_sha=$(printf 'b%.0s' {1..40})
run_case() {
  local case=$1 event=${2:-merge_group}
  local case_dir="$test_dir/$case" lookup_sha="$build_sha" ref="refs/heads/gh-readonly-queue/main/pr-123-$build_sha"
  local wait_seconds=1800
  if [ "$case" = near-deadline ]; then wait_seconds=1; fi
  mkdir -p "$case_dir"
  echo 1000 >"$case_dir/clock"
  if [ "$event" = pull_request ]; then lookup_sha=$pr_sha; ref=refs/pull/123/merge; fi
  env -i PATH="$test_dir/bin:$PATH" GH_TOKEN=fixture MOCK_ROOT="$case_dir" MOCK_CASE="$case" \
    GITHUB_REPOSITORY=okou-ai/okou GITHUB_RUN_ID=777 GITHUB_RUN_ATTEMPT=1 \
    GITHUB_EVENT_NAME="$event" GITHUB_REF="$ref" GITHUB_HEAD_REF=fixture-head GITHUB_SHA="$build_sha" \
    HEAD_SHA="$build_sha" LOOKUP_SHA="$lookup_sha" JOB_REF=pr-123 METAL_HOSTS=fixture TARGET=aarch64-unknown-linux-musl \
    PROFILE=vm0/default OUTPUT_DIR="$case_dir/output" GITHUB_OUTPUT="$case_dir/outputs" \
    CONSUMER_CANCEL_WAIT_SECONDS=5 TIMEOUT_SECONDS="$wait_seconds" POLL_SECONDS=0 \
    bash "$root/.github/scripts/runner/wait-runner-image.sh" >"$case_dir/stdout" 2>"$case_dir/stderr"
}

for case in missing-ref changed-ref rate-limited changed-pr closed-pr queued-pr cancel-conflict near-deadline crates-missing-ref crates-changed-pr initial-run-rate-limited final-ref-rate-limited; do
  event=merge_group
  case "$case" in *-pr) event=pull_request ;; esac
  if run_case "$case" "$event"; then fail "obsolete $case must await interruption, never succeed"; else status=$?; fi
  [ "$status" -eq 143 ] || fail "$case must terminate through the external cancellation signal (got $status)"
  [ "$(cat "$test_dir/$case/cancelled")" = 'repos/okou-ai/okou/actions/runs/777/force-cancel' ] || fail "wrong native cancellation target"
  [ ! -s "$test_dir/$case/outputs" ] || fail "cancelled wait must not emit manifest outputs"
done

for case in current current-pr producer-failed wrong-workflow other-repository other-pr wrong-sha new-attempt attempt-changed invalid-status ref-denied malformed-ref pr-query-error owner-restored authority-restored-during-run-retry authority-restored-during-run-transient; do
  event=merge_group
  case "$case" in current-pr|pr-query-error) event=pull_request ;; esac
  if run_case "$case" "$event"; then fail "$case must retain its failure, never pass"; else status=$?; fi
  [ "$status" -eq 1 ] || fail "unexpected $case status: $status"
  [ ! -f "$test_dir/$case/cancelled" ] || fail "$case must not cancel a native run"
done
grep -q 'conclusion=failure' "$test_dir/producer-failed/stderr" || fail "true producer failure must be preserved"

for case in cancel-denied no-interruption; do
  if run_case "$case"; then fail "$case must not become success"; else status=$?; fi
  [ "$status" -eq 1 ] || fail "unexpected $case status: $status"
  [ ! -s "$test_dir/$case/outputs" ] || fail "$case must not emit manifest outputs"
done
grep -q 'did not interrupt obsolete consumer' "$test_dir/no-interruption/stderr" || fail "accepted cancellation still needs interruption"

# Staging / production consumers must retain dependency failures and cannot
# enter the native PR cancellation path when using the same waiter.
if run_case push push; then fail "push dependency cancellation must not pass"; fi
[ ! -f "$test_dir/push/cancelled" ] || fail "must not cancel a production/staging run"
if grep -q 'actions/runs/777 ' "$test_dir/push/gh.log"; then fail "push must skip native consumer inspection"; fi

ruby -ryaml - "$root" <<'RUBY'
root = ARGV.fetch(0)
{"turbo" => ["deploy-runner-prepare"], "crates" => ["runner-test-prepare"]}.each do |workflow, names|
  jobs = YAML.load_file("#{root}/.github/workflows/#{workflow}.yml").fetch("jobs")
  names.each do |name|
    job = jobs.fetch(name)
    raise "missing native cancellation permission: #{name}" unless job.fetch("permissions") == {
      "actions" => "write", "contents" => "read", "pull-requests" => "read"
    }
  end
end
RUBY
echo "wait-runner-image-cancellation-test: ok"
