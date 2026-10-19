#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

# The external Runner peer returns operation-scoped results and stream/journal
# evidence. The real driver must reject inconsistent native evidence.
cat > "$tmp/bin/submit" << 'SUBMIT'
#!/usr/bin/env bash
set -euo pipefail
shift
prompt=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = --prompt ]; then
    prompt=$2
    shift 2
  else
    shift
  fi
done
count=0
if [ -f "$TEST_STATE/count" ]; then count=$(< "$TEST_STATE/count"); fi
count=$((count + 1))
printf '%s\n' "$count" > "$TEST_STATE/count"
printf -v run_id '11111111-1111-4111-8111-%012d' "$count"
log="$TEST_STATE/system-stream-${run_id}.log"
status=0
exit_code=0
reused=true
case "$prompt" in
  @parallel-shell-tool-oom)
    printf '%s\n' 'parallel-shell-tool-oom-survived oom_group_kill=1' \
      'workload resource limit reached memory_oom_kill=2 memory_oom_group_kill=1' > "$log"
    ;;
  @guest-wide-tool-oom-injected)
    printf '%s\n' 'parallel-shell-tool-oom-survived oom_group_kill=1 guest_wide=true memcg_ooms=0 trigger=sysrq' \
      'oom_classification=contained_tool_oom' > "$log"
    ;;
  @managed-task-oom)
    printf '%s\n' 'nested-managed-task-oom-survived oom_group_kill=1 guest_wide=false memcg_ooms=1 trigger=pressure reclaimed_bytes=100000000' \
      'oom_classification=contained_tool_oom' > "$log"
    ;;
  @guest-wide-task-oom-injected)
    trigger=sysrq
    classification=contained_tool_oom
    if [ "$TEST_MODE" = wrong-trigger ]; then trigger=pressure; fi
    if [ "$TEST_MODE" = unproven ]; then classification=unproven_containment; fi
    printf '%s\n' \
      "nested-managed-task-oom-survived oom_group_kill=1 guest_wide=true memcg_ooms=0 trigger=$trigger reclaimed_bytes=100000000" \
      "oom_classification=$classification" > "$log"
    if [ "$TEST_MODE" = late-classification ]; then
      head -n 1 "$log" > "$log.pending"
      mv "$log.pending" "$log"
      printf '%s\n' "$log" > "$TEST_STATE/delayed-log"
    fi
    ;;
  @runtime-only-oom)
    status=1
    exit_code=137
    printf 'run_id=%s job execution failed resource_failure_kind="guest_memory_oom_killed"\n' "$run_id" >> "$TEST_STATE/journal"
    ;;
  true)
    if [ "$TEST_MODE" = not-reused ] && [ "$(< "$TEST_STATE/last")" = @guest-wide-task-oom-injected ]; then
      reused=false
    fi
    ;;
  *pid-pressure-ready*)
    printf '%s\n' 'pid-pressure-complete children=62 pids_max=1' > "$log"
    ;;
  'test -f /tmp/vm0-process-containment/'*) ;;
  *) echo "unexpected Runner prompt: $prompt" >&2; exit 2 ;;
esac
if [ "$status" -eq 0 ]; then
  printf 'run_id=%s job finished reused=%s\n' "$run_id" "$reused" >> "$TEST_STATE/journal"
fi
printf '%s\n' "$prompt" > "$TEST_STATE/last"
printf '{"run_id":"%s","exit_code":%s,"error":null}\n' "$run_id" "$exit_code"
exit "$status"
SUBMIT

cat > "$tmp/bin/sudo" << 'SUDO'
#!/usr/bin/env bash
set -euo pipefail
command=$1
shift
case "$command" in
  journalctl) cat "$TEST_STATE/journal" ;;
  grep|tail)
    args=()
    for arg in "$@"; do
      args+=("${arg/#\/var\/lib\/vm0-runner\/logs\//$TEST_STATE/}")
    done
    exec "$command" "${args[@]}"
    ;;
  *) echo "unexpected host operation: $command" >&2; exit 2 ;;
esac
SUDO

# Control stream delivery at the final bounded observation without a real-time
# wait. Other cases keep their classification present or permanently absent.
cat > "$tmp/bin/sleep" << 'SLEEP'
#!/usr/bin/env bash
set -euo pipefail
if [ -f "$TEST_STATE/delayed-log" ]; then
  count=0
  if [ -f "$TEST_STATE/observations" ]; then count=$(< "$TEST_STATE/observations"); fi
  count=$((count + 1))
  printf '%s\n' "$count" > "$TEST_STATE/observations"
  if [ "$count" -eq 50 ]; then
    printf '%s\n' 'oom_classification=contained_tool_oom' >> "$(< "$TEST_STATE/delayed-log")"
    rm "$TEST_STATE/delayed-log"
  fi
fi
exit 0
SLEEP
chmod +x "$tmp/bin/submit" "$tmp/bin/sudo" "$tmp/bin/sleep"

run_case() {
  local mode=$1
  local expected=$2
  local diagnostic=$3
  local state="$tmp/$mode"
  local status=0
  mkdir -p "$state"
  TEST_MODE="$mode" TEST_STATE="$state" PATH="$tmp/bin:$PATH" \
    PROCESS_CONTAINMENT_SUBMIT="$tmp/bin/submit" \
    bash "$SCRIPT_DIR/runner-behavior-process-containment-resource-pressure.sh" \
    /fake/bin fixture-group fixture-invocation > "$state/output" 2>&1 || status=$?
  if [ "$status" -ne "$expected" ] || ! grep -F -q "$diagnostic" "$state/output"; then
    cat "$state/output" >&2
    echo "unexpected $mode outcome: $status" >&2
    exit 1
  fi
}

run_case success 0 'PASS: Guest-wide OOM preserved tool isolation and runtime-only OOM attribution'
run_case late-classification 0 'PASS: Guest-wide OOM preserved tool isolation and runtime-only OOM attribution'
run_case wrong-trigger 1 'task family retirement, memory reclamation or OOM scope was not verified'
run_case unproven 1 'nested task guest OOM was not classified as contained'
run_case not-reused 1 'task OOM follow-up did not reuse its sandbox'
echo "runner-behavior-process-containment-pressure-test: ok"
