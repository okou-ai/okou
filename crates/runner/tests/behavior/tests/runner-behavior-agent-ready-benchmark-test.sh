#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../../../../.." && pwd)
WORKER="$REPO_ROOT/crates/runner/tests/behavior/runner-behavior-agent-ready-benchmark-remote.sh"

assert_contains() {
  local file=$1
  local expected=$2

  if ! grep -Fq -- "$expected" "$file"; then
    echo "expected ${file} to contain: ${expected}" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_count() {
  local file=$1
  local expected=$2
  local value=$3
  local actual=""

  actual=$(grep -Fc -- "$value" "$file" || true)
  if [ "$actual" -ne "$expected" ]; then
    echo "expected ${file} to contain ${value} ${expected} time(s); got ${actual}" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_value() {
  local file=$1
  local expected=$2
  local actual=""

  actual=$(<"$file")
  if [ "$actual" != "$expected" ]; then
    echo "expected ${file} to contain ${expected}; got ${actual}" >&2
    exit 1
  fi
}

assert_summary() {
  local file=$1
  local sample_count=$2
  local ready_timings=$3

  sed '1,/^AGENT_READY_BENCHMARK_RAW_END$/d' "$file" \
    | jq -e --argjson sample_count "$sample_count" --argjson ready_timings "$ready_timings" '
        ([.[].path] == ["fresh", "home-cache", "exact-reuse"])
        and all(.[]; .sample_count == $sample_count and .failures == 0)
        and ([.[].metrics.agent_ready_ms] == $ready_timings)
        and all(.[] | .metrics[];
          (.min | type == "number")
          and (.p50 | type == "number")
          and (.max | type == "number")
          and .min <= .p50 and .p50 <= .max)
      ' >/dev/null
}

tmp=$(mktemp -d)
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

fake_bin="$tmp/bin"
mkdir -p "$fake_bin"

cat > "$fake_bin/sudo" <<'FAKE_SUDO'
#!/usr/bin/env bash
set -euo pipefail

increment() {
  local name=$1
  local file="$TEST_STATE_DIR/$name"
  local value=0

  if [ -f "$file" ]; then
    value=$(<"$file")
  fi
  value=$((value + 1))
  printf '%s\n' "$value" > "$file"
  printf '%s\n' "$value"
}

write_agent_log() {
  local run_id=$1
  local sandbox_reuse=$2
  local home_reuse=$3
  local duration=${run_id#run-}
  local agent_ready_ms=$((duration + 1))

  if [ "$TEST_SCENARIO" = invalid-timing ] && [ "$run_id" = run-1 ]; then
    agent_ready_ms=invalid
  fi

  printf '%s\n' \
    "run_id=${run_id} agent startup timing sandbox_reuse=${sandbox_reuse} home_reuse=${home_reuse} shell_spawn_ms=${duration} agent_ready_ms=${agent_ready_ms} containment_create_us=$((duration + 2)) placement_broker_setup_us=$((duration + 3)) shell_spawn_component_us=$((duration + 4)) bootstrap_ready_wait_us=$((duration + 5))" \
    >> "$TEST_STATE_DIR/journal"
}

if [ "$1" = "journalctl" ]; then
  if [ "$#" -ne 3 ] \
    || [ "$2" != "--no-pager" ] \
    || [ "$3" != "_SYSTEMD_INVOCATION_ID=invocation-id" ]; then
    echo "journal read was not scoped to the expected invocation: $*" >&2
    exit 2
  fi
  cat "$TEST_STATE_DIR/journal"
  exit 0
fi

if [ "$1" != "/fake/bin/runner" ] || [ "$2" != "local" ] || [ "$3" != "submit" ]; then
  echo "unexpected sudo invocation: $*" >&2
  exit 2
fi

session_id=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--session-id" ]; then
    session_id=$2
    break
  fi
  shift
done
[ -n "$session_id" ] || { echo "local submit omitted session ID" >&2; exit 2; }

submit_count=$(increment submit-count)
run_id="run-${submit_count}"

case "$session_id" in
  agent-ready-fresh-*)
    if [ "$TEST_SCENARIO" = unexpected-fresh-reuse ]; then
      write_agent_log "$run_id" Reused CacheMiss
    else
      write_agent_log "$run_id" PoolMiss CacheMiss
    fi
    ;;
  agent-ready-home)
    home_reuse=CacheMiss
    if [ -f "$TEST_STATE_DIR/last-promotion" ] \
      && [ "$(<"$TEST_STATE_DIR/last-promotion")" = promoted ]; then
      home_reuse=Reused
      if [ "$TEST_SCENARIO" = confirmed-miss ]; then
        home_reuse=CacheMiss
      fi
    fi
    write_agent_log "$run_id" PoolMiss "$home_reuse"
    printf '%s\n' "$run_id" > "$TEST_STATE_DIR/home-run-id"
    ;;
  agent-ready-home-evictor)
    home_run_id=$(<"$TEST_STATE_DIR/home-run-id")
    printf '%s\n' promoted > "$TEST_STATE_DIR/last-promotion"
    case "$TEST_SCENARIO" in
      publication-failed) outcome='home image publication failed' ;;
      publication-rejected) outcome='home image publication rejected because guest preparation failed' ;;
      *) outcome='home image cache promoted' ;;
    esac
    printf '%s\n' "run_id=${home_run_id} $outcome" >> "$TEST_STATE_DIR/journal"
    # Another run's success must not satisfy the current run's outcome check.
    printf '%s\n' 'run_id=unrelated-run home image cache promoted' \
      >> "$TEST_STATE_DIR/journal"
    ;;
  agent-ready-exact-reuse)
    exact_count=$(increment exact-count)
    if [ "$exact_count" -eq 1 ]; then
      write_agent_log "$run_id" PoolMiss CacheMiss
    elif [ "$TEST_SCENARIO" = exact-reuse-miss ]; then
      write_agent_log "$run_id" PoolMiss CacheMiss
    else
      write_agent_log "$run_id" Reused SandboxReused
    fi
    ;;
  *)
    echo "unexpected session ID: $session_id" >&2
    exit 2
    ;;
esac

printf '{"run_id":"%s"}\n' "$run_id"
FAKE_SUDO
chmod +x "$fake_bin/sudo"

LAST_CASE_DIR=""

run_case() {
  local name=$1
  local scenario=$2
  local expected_status=$3
  local sample_count=$4
  local case_dir="$tmp/$name"
  local status=0

  mkdir -p "$case_dir"
  : > "$case_dir/journal"
  set +e
  TEST_SCENARIO="$scenario" \
    TEST_STATE_DIR="$case_dir" \
    PATH="$fake_bin:$PATH" \
    bash "$WORKER" /fake/bin vm0/test invocation-id "$sample_count" \
    > "$case_dir/output" 2>&1
  status=$?
  set -e
  if [ "$status" -ne "$expected_status" ]; then
    echo "expected ${name} status ${expected_status}; got ${status}" >&2
    cat "$case_dir/output" >&2
    exit 1
  fi
  LAST_CASE_DIR=$case_dir
}

run_case routine-success direct-success 0 1
assert_count "$LAST_CASE_DIR/output" 1 '"path":"fresh","success":true'
assert_count "$LAST_CASE_DIR/output" 1 '"path":"home-cache","success":true'
assert_count "$LAST_CASE_DIR/output" 1 '"path":"exact-reuse","success":true'
assert_value "$LAST_CASE_DIR/submit-count" 6
assert_contains "$LAST_CASE_DIR/output" 'Agent-ready local submissions: 6'
assert_summary "$LAST_CASE_DIR/output" 1 \
  '[{"min":2,"p50":2,"max":2},{"min":5,"p50":5,"max":5},{"min":7,"p50":7,"max":7}]'

run_case repeat-success direct-success 0 3
assert_count "$LAST_CASE_DIR/output" 3 '"path":"fresh","success":true'
assert_count "$LAST_CASE_DIR/output" 3 '"path":"home-cache","success":true'
assert_count "$LAST_CASE_DIR/output" 3 '"path":"exact-reuse","success":true'
assert_value "$LAST_CASE_DIR/submit-count" 14
assert_contains "$LAST_CASE_DIR/output" 'Agent-ready local submissions: 14'
assert_summary "$LAST_CASE_DIR/output" 3 \
  '[{"min":2,"p50":3,"max":4},{"min":7,"p50":9,"max":11},{"min":13,"p50":14,"max":15}]'

for scenario in unexpected-fresh-reuse exact-reuse-miss invalid-timing; do
  run_case "$scenario" "$scenario" 1 1
  assert_contains "$LAST_CASE_DIR/output" 'Agent-ready benchmark recorded 1 failures'
  assert_value "$LAST_CASE_DIR/submit-count" 6
done

run_case confirmed-miss confirmed-miss 1 1
assert_contains "$LAST_CASE_DIR/output" \
  'home-cache sample failed after confirmed promotion: expected home_reuse=Reused, observed CacheMiss'
assert_value "$LAST_CASE_DIR/submit-count" 4

for scenario in publication-failed publication-rejected; do
  run_case "$scenario" "$scenario" 1 1
  assert_contains "$LAST_CASE_DIR/output" \
    'unexpected home-cache promotion outcome for run run-2'
  assert_count "$LAST_CASE_DIR/output" 0 'RETRY:'
  assert_value "$LAST_CASE_DIR/submit-count" 3
done

echo "PASS: Agent-ready paths retain outcomes, timing checks, and committed promotion"
