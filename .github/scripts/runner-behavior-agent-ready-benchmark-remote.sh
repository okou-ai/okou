#!/usr/bin/env bash
set -euo pipefail

BIN_DIR=$1
GROUP=$2
INVOCATION_ID=$3
AGENT_READY_BENCHMARK_SAMPLES=$4
MAX_HOME_PROMOTION_RETRIES=3
AGENT_READY_BENCHMARK_RAW=""
AGENT_READY_LAST_RUN_ID=""
AGENT_READY_SAMPLE_ERROR=""
AGENT_READY_SUBMIT_ERROR=""
AGENT_READY_SUBMIT_RUN_ID=""

fail() { echo "FAIL: $1" >&2; exit 1; }

case "$AGENT_READY_BENCHMARK_SAMPLES" in
  ''|*[!0-9]*) fail "Agent-ready benchmark sample count must be an integer" ;;
esac
if [ "$AGENT_READY_BENCHMARK_SAMPLES" -lt 1 ] \
  || [ "$AGENT_READY_BENCHMARK_SAMPLES" -gt 100 ]; then
  fail "Agent-ready benchmark sample count must be between 1 and 100"
fi

cleanup() {
  if [ -n "$AGENT_READY_BENCHMARK_RAW" ]; then
    rm -f "$AGENT_READY_BENCHMARK_RAW"
  fi
}
trap cleanup EXIT

AGENT_READY_BENCHMARK_RAW=$(mktemp)

record_agent_ready_benchmark_failure() {
  local path=$1
  local run_id=$2
  local error=$3
  error=$(printf '%s' "$error" | tail -c 512)
  AGENT_READY_SAMPLE_ERROR=$error
  jq -cn \
    --arg path "$path" \
    --arg run_id "$run_id" \
    --arg error "$error" \
    '{path: $path, success: false, run_id: $run_id, error: $error}' \
    >> "$AGENT_READY_BENCHMARK_RAW"
}

agent_ready_log_field() {
  local line=$1
  local field=$2
  sed -n "s/.*${field}=\\([^ ]*\\).*/\\1/p" <<<"$line"
}

read_agent_ready_log() {
  local run_id=$1
  local line=""
  for _ in $(seq 1 50); do
    line=$(sudo journalctl --no-pager "_SYSTEMD_INVOCATION_ID=$INVOCATION_ID" 2>&1 \
      | grep -F "run_id=$run_id" \
      | grep -F 'agent startup timing' \
      | tail -n 1) || true
    if [ -n "$line" ]; then
      printf '%s\n' "$line"
      return 0
    fi
    sleep 0.1
  done
  return 1
}

submit_agent_ready_benchmark_run() {
  local chat_thread_id=$1
  local session_id=$2
  local result=""
  local result_json=""

  AGENT_READY_SUBMIT_ERROR=""
  AGENT_READY_SUBMIT_RUN_ID=""
  if ! result=$(sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
    --chat-thread-id "$chat_thread_id" \
    --session-id "$session_id" \
    --feature-flag sandboxReuse=true \
    --prompt 'true' 2>&1); then
    AGENT_READY_SUBMIT_ERROR="local submit failed: $result"
    return 1
  fi
  result_json=$(awk '/^\{/{line=$0} END{print line}' <<<"$result")
  AGENT_READY_SUBMIT_RUN_ID=$(jq -r '.run_id // empty' <<<"$result_json" 2>/dev/null) \
    || true
  if [ -z "$AGENT_READY_SUBMIT_RUN_ID" ]; then
    AGENT_READY_SUBMIT_ERROR="local submit omitted run ID"
    return 1
  fi
}

record_agent_ready_benchmark_sample() {
  local path=$1
  local expected_sandbox_reuse=$2
  local expected_workspace_reuse=$3
  local chat_thread_id=$4
  local session_id=$5
  local run_id=""
  local ready_log=""
  local sandbox_reuse=""
  local workspace_reuse=""
  local shell_spawn_ms=""
  local agent_ready_ms=""
  local containment_create_us=""
  local placement_broker_setup_us=""
  local shell_spawn_component_us=""
  local bootstrap_ready_wait_us=""

  AGENT_READY_LAST_RUN_ID=""
  AGENT_READY_SAMPLE_ERROR=""
  if ! submit_agent_ready_benchmark_run "$chat_thread_id" "$session_id"; then
    record_agent_ready_benchmark_failure "$path" "" "$AGENT_READY_SUBMIT_ERROR"
    return 1
  fi
  run_id=$AGENT_READY_SUBMIT_RUN_ID
  AGENT_READY_LAST_RUN_ID=$run_id
  if ! ready_log=$(read_agent_ready_log "$run_id"); then
    record_agent_ready_benchmark_failure "$path" "$run_id" "Agent-ready log was not found"
    return 1
  fi

  sandbox_reuse=$(agent_ready_log_field "$ready_log" sandbox_reuse)
  workspace_reuse=$(agent_ready_log_field "$ready_log" workspace_reuse)
  if [ "$sandbox_reuse" != "$expected_sandbox_reuse" ]; then
    record_agent_ready_benchmark_failure "$path" "$run_id" \
      "expected sandbox_reuse=$expected_sandbox_reuse, observed $sandbox_reuse"
    return 1
  fi
  if [ -n "$expected_workspace_reuse" ] \
    && [ "$workspace_reuse" != "$expected_workspace_reuse" ]; then
    record_agent_ready_benchmark_failure "$path" "$run_id" \
      "expected workspace_reuse=$expected_workspace_reuse, observed $workspace_reuse"
    return 1
  fi

  shell_spawn_ms=$(agent_ready_log_field "$ready_log" shell_spawn_ms)
  agent_ready_ms=$(agent_ready_log_field "$ready_log" agent_ready_ms)
  containment_create_us=$(agent_ready_log_field "$ready_log" containment_create_us)
  placement_broker_setup_us=$(agent_ready_log_field "$ready_log" placement_broker_setup_us)
  shell_spawn_component_us=$(agent_ready_log_field "$ready_log" shell_spawn_component_us)
  bootstrap_ready_wait_us=$(agent_ready_log_field "$ready_log" bootstrap_ready_wait_us)
  for value in \
    "$shell_spawn_ms" \
    "$agent_ready_ms" \
    "$containment_create_us" \
    "$placement_broker_setup_us" \
    "$shell_spawn_component_us" \
    "$bootstrap_ready_wait_us"; do
    case "$value" in
      ''|*[!0-9]*)
        record_agent_ready_benchmark_failure "$path" "$run_id" \
          "Agent-ready log contained a missing or invalid duration"
        return 1
        ;;
    esac
  done

  jq -cn \
    --arg path "$path" \
    --arg run_id "$run_id" \
    --arg sandbox_reuse "$sandbox_reuse" \
    --arg workspace_reuse "$workspace_reuse" \
    --argjson shell_spawn_ms "$shell_spawn_ms" \
    --argjson agent_ready_ms "$agent_ready_ms" \
    --argjson containment_create_us "$containment_create_us" \
    --argjson placement_broker_setup_us "$placement_broker_setup_us" \
    --argjson shell_spawn_component_us "$shell_spawn_component_us" \
    --argjson bootstrap_ready_wait_us "$bootstrap_ready_wait_us" \
    '{
      path: $path,
      success: true,
      run_id: $run_id,
      sandbox_reuse: $sandbox_reuse,
      workspace_reuse: $workspace_reuse,
      shell_spawn_ms: $shell_spawn_ms,
      agent_ready_ms: $agent_ready_ms,
      containment_create_us: $containment_create_us,
      placement_broker_setup_us: $placement_broker_setup_us,
      shell_spawn_component_us: $shell_spawn_component_us,
      bootstrap_ready_wait_us: $bootstrap_ready_wait_us
    }' >> "$AGENT_READY_BENCHMARK_RAW"
}

read_home_promotion_log() {
  local run_id=$1
  local line=""
  for _ in $(seq 1 50); do
    line=$(sudo journalctl --no-pager "_SYSTEMD_INVOCATION_ID=$INVOCATION_ID" 2>&1 \
      | grep -F "run_id=$run_id" \
      | grep -E 'home image cache (promoted|promotion skipped)|home image publication (failed|rejected)' \
      | tail -n 1) || true
    if [ -n "$line" ]; then
      printf '%s\n' "$line"
      return 0
    fi
    sleep 0.1
  done
  return 1
}

print_home_promotion_diagnostics() {
  local run_id=$1
  local logs=""
  local lines=""
  echo "--- Home cache promotion logs for run ${run_id} ---" >&2
  logs=$(sudo journalctl --no-pager "_SYSTEMD_INVOCATION_ID=$INVOCATION_ID" 2>&1) \
    || true
  lines=$(printf '%s\n' "$logs" \
    | grep -F "run_id=$run_id" \
    | grep -E 'home image cache|home image publication') || true
  if [ -n "$lines" ]; then
    printf '%s\n' "$lines" >&2
  else
    echo "No home image cache logs found" >&2
  fi
}

for index in $(seq 1 "$AGENT_READY_BENCHMARK_SAMPLES"); do
  thread_id=$(cat /proc/sys/kernel/random/uuid)
  record_agent_ready_benchmark_sample \
    fresh PoolMiss CacheMiss "$thread_id" "agent-ready-fresh-$index" \
    || true
done

HOME_BENCHMARK_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
HOME_BENCHMARK_EVICTOR_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
if ! submit_agent_ready_benchmark_run \
  "$HOME_BENCHMARK_THREAD_ID" agent-ready-home; then
  fail "home-cache Agent-ready benchmark warmup failed: $AGENT_READY_SUBMIT_ERROR"
fi
HOME_BENCHMARK_RUN_ID=$AGENT_READY_SUBMIT_RUN_ID
HOME_BENCHMARK_SUCCESSFUL_SAMPLES=0
HOME_BENCHMARK_PROMOTION_ATTEMPTS=0
HOME_BENCHMARK_MAX_PROMOTION_ATTEMPTS=$((
  AGENT_READY_BENCHMARK_SAMPLES + MAX_HOME_PROMOTION_RETRIES
))

while [ "$HOME_BENCHMARK_SUCCESSFUL_SAMPLES" -lt "$AGENT_READY_BENCHMARK_SAMPLES" ]; do
  HOME_BENCHMARK_PROMOTION_ATTEMPTS=$((HOME_BENCHMARK_PROMOTION_ATTEMPTS + 1))
  if ! submit_agent_ready_benchmark_run \
    "$HOME_BENCHMARK_EVICTOR_THREAD_ID" agent-ready-home-evictor; then
    fail "home-cache Agent-ready benchmark eviction failed: $AGENT_READY_SUBMIT_ERROR"
  fi

  if ! promotion_log=$(read_home_promotion_log "$HOME_BENCHMARK_RUN_ID"); then
    print_home_promotion_diagnostics "$HOME_BENCHMARK_RUN_ID"
    fail "home-cache promotion outcome was not found for run $HOME_BENCHMARK_RUN_ID"
  fi

  if grep -F 'home image cache promotion skipped: capacity lock busy' \
    <<<"$promotion_log" >/dev/null; then
    if [ "$HOME_BENCHMARK_PROMOTION_ATTEMPTS" \
      -ge "$HOME_BENCHMARK_MAX_PROMOTION_ATTEMPTS" ]; then
      print_home_promotion_diagnostics "$HOME_BENCHMARK_RUN_ID"
      fail "home-cache promotion capacity lock remained busy after ${HOME_BENCHMARK_PROMOTION_ATTEMPTS} attempts"
    fi
    echo "RETRY: home-cache promotion capacity lock was busy for run ${HOME_BENCHMARK_RUN_ID}"
    if ! submit_agent_ready_benchmark_run \
      "$HOME_BENCHMARK_THREAD_ID" agent-ready-home; then
      fail "home-cache Agent-ready benchmark re-prime failed: $AGENT_READY_SUBMIT_ERROR"
    fi
    HOME_BENCHMARK_RUN_ID=$AGENT_READY_SUBMIT_RUN_ID
    continue
  fi

  if ! grep -F 'home image cache promoted' <<<"$promotion_log" >/dev/null; then
    print_home_promotion_diagnostics "$HOME_BENCHMARK_RUN_ID"
    fail "unexpected home-cache promotion outcome for run $HOME_BENCHMARK_RUN_ID"
  fi

  if ! record_agent_ready_benchmark_sample \
    home-cache PoolMiss Reused \
    "$HOME_BENCHMARK_THREAD_ID" agent-ready-home; then
    fail "home-cache sample failed after confirmed promotion: $AGENT_READY_SAMPLE_ERROR"
  fi
  HOME_BENCHMARK_RUN_ID=$AGENT_READY_LAST_RUN_ID
  HOME_BENCHMARK_SUCCESSFUL_SAMPLES=$((HOME_BENCHMARK_SUCCESSFUL_SAMPLES + 1))
done

EXACT_REUSE_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
if ! submit_agent_ready_benchmark_run \
  "$EXACT_REUSE_THREAD_ID" agent-ready-exact-reuse; then
  fail "exact-reuse Agent-ready benchmark warmup failed: $AGENT_READY_SUBMIT_ERROR"
fi
for _ in $(seq 1 "$AGENT_READY_BENCHMARK_SAMPLES"); do
  record_agent_ready_benchmark_sample \
    exact-reuse Reused SandboxReused \
    "$EXACT_REUSE_THREAD_ID" agent-ready-exact-reuse \
    || true
done

echo "AGENT_READY_BENCHMARK_RAW_BEGIN"
cat "$AGENT_READY_BENCHMARK_RAW"
echo "AGENT_READY_BENCHMARK_RAW_END"
jq -s '
  def percentile($values; $ratio):
    ($values | sort) as $ordered
    | if ($ordered | length) == 0 then null
      else $ordered[((($ordered | length) * $ratio | ceil) - 1)]
      end;
  def metric_summary($rows; $field):
    [$rows[] | select(.success) | .[$field]] as $values
    | {
        p50: percentile($values; 0.50),
        p90: percentile($values; 0.90),
        p95: percentile($values; 0.95),
        p99: percentile($values; 0.99)
      };
  . as $records
  | ["fresh", "home-cache", "exact-reuse"]
  | map(
      . as $path
      | [$records[] | select(.path == $path)] as $rows
      | {
          path: $path,
          sample_count: ($rows | length),
          failures: ([$rows[] | select(.success | not)] | length),
          metrics: {
            shell_spawn_ms: metric_summary($rows; "shell_spawn_ms"),
            agent_ready_ms: metric_summary($rows; "agent_ready_ms"),
            containment_create_us: metric_summary($rows; "containment_create_us"),
            placement_broker_setup_us: metric_summary($rows; "placement_broker_setup_us"),
            shell_spawn_component_us: metric_summary($rows; "shell_spawn_component_us"),
            bootstrap_ready_wait_us: metric_summary($rows; "bootstrap_ready_wait_us")
          }
        }
    )
' "$AGENT_READY_BENCHMARK_RAW"

AGENT_READY_BENCHMARK_FAILURES=$(jq -s '[.[] | select(.success | not)] | length' \
  "$AGENT_READY_BENCHMARK_RAW")
[ "$AGENT_READY_BENCHMARK_FAILURES" -eq 0 ] \
  || fail "Agent-ready benchmark recorded $AGENT_READY_BENCHMARK_FAILURES failures"
