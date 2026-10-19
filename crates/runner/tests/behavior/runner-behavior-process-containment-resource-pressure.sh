#!/usr/bin/env bash
set -euo pipefail

BIN_DIR=$1
GROUP=$2
INVOCATION_ID=$3

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

require_contained_tool_oom() {
  local log=$1
  # System-stream delivery is asynchronous; observe the classification rather
  # than treating the local-submit response as a log-flush acknowledgement.
  for _ in $(seq 1 50); do
    if sudo grep -F -q 'oom_classification=contained_tool_oom' "$log"; then
      return 0
    fi
    sleep 0.1
  done
  if sudo grep -F -q 'oom_classification=contained_tool_oom' "$log"; then
    return 0
  fi
  sudo tail -n 80 "$log" >&2 || true
  fail "$2"
}

TASK_REUSE_RUN_IDS=()

# Each pressure case owns its independent chat and the follow-up reuse proof.
echo "--- Pressure: group-kill only the high-memory Bash tool ---"
# The mock CLI launches two Bash children directly from the managed runtime.
# The launcher places them in distinct tool cgroups before either shell runs.
# One tool drives the existing workload limit to OOM while the other remains alive.
# Use a fresh sandbox so the tool-isolation assertion has an independent
# lifecycle after the preceding CPU-pressure scenario.
MEMORY_CHAT_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
MEMORY_SESSION_ID="e2e-process-containment-memory"
if ! MEMORY_RESULT=$("$PROCESS_CONTAINMENT_SUBMIT" "$BIN_DIR" --group "$GROUP" \
  --chat-thread-id "$MEMORY_CHAT_THREAD_ID" \
  --session-id "$MEMORY_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt '@parallel-shell-tool-oom' \
  --active-input 'after=1s,text=memory-pressure-control'); then
  printf '%s\n' "$MEMORY_RESULT"
  fail "memory-pressure submit failed before tool OOM isolation completed"
fi
printf '%s\n' "$MEMORY_RESULT"
MEMORY_RESULT_JSON=$(awk '/^\{/{line=$0} END{print line}' <<< "$MEMORY_RESULT")
MEMORY_RUN_ID=$(jq -r '.run_id // empty' <<< "$MEMORY_RESULT_JSON")
[ -n "$MEMORY_RUN_ID" ] || fail "memory-pressure result omitted run ID"
MEMORY_STREAM_LOG="/var/lib/vm0-runner/logs/system-stream-${MEMORY_RUN_ID}.log"
sudo grep -F -q 'parallel-shell-tool-oom-survived oom_group_kill=' "$MEMORY_STREAM_LOG" \
  || fail "CLI or unrelated Bash tool did not survive the offender group OOM"
sudo grep -F -q 'workload resource limit reached' "$MEMORY_STREAM_LOG" \
  || fail "memory-pressure resource event was not classified"
sudo grep -E -q 'memory_oom_kill=[1-9][0-9]*' "$MEMORY_STREAM_LOG" \
  || fail "memory-pressure diagnostics omitted the OOM event"
sudo grep -E -q 'memory_oom_group_kill=[1-9][0-9]*' "$MEMORY_STREAM_LOG" \
  || fail "memory-pressure diagnostics omitted the group OOM event"

echo "--- Pressure: prove tool-group OOM preserved sandbox reuse ---"
MEMORY_REUSE_RESULT=$("$PROCESS_CONTAINMENT_SUBMIT" "$BIN_DIR" --group "$GROUP" \
  --chat-thread-id "$MEMORY_CHAT_THREAD_ID" \
  --session-id "$MEMORY_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'true') \
  || fail "memory-pressure recovery did not preserve safe sandbox reuse"
printf '%s\n' "$MEMORY_REUSE_RESULT"
MEMORY_REUSE_RESULT_JSON=$(awk '/^\{/{line=$0} END{print line}' <<< "$MEMORY_REUSE_RESULT")
MEMORY_REUSE_RUN_ID=$(jq -r '.run_id // empty' <<< "$MEMORY_REUSE_RESULT_JSON")
[ -n "$MEMORY_REUSE_RUN_ID" ] || fail "memory-pressure reuse result omitted run ID"

echo "--- Pressure: prefer tools during injected Guest-wide OOM ---"
GLOBAL_MEMORY_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
if GLOBAL_MEMORY_RESULT=$("$PROCESS_CONTAINMENT_SUBMIT" "$BIN_DIR" --group "$GROUP" \
  --chat-thread-id "$GLOBAL_MEMORY_THREAD_ID" \
  --session-id e2e-process-containment-global-memory \
  --feature-flag sandboxReuse=true \
  --prompt '@guest-wide-tool-oom-injected'); then
  :
else
  printf '%s\n' "$GLOBAL_MEMORY_RESULT" >&2
  GLOBAL_MEMORY_FAILURE_JSON=$(awk '/^\{/{line=$0} END{print line}' <<< "$GLOBAL_MEMORY_RESULT")
  GLOBAL_MEMORY_FAILURE_RUN_ID=$(jq -r '.run_id // empty' <<< "$GLOBAL_MEMORY_FAILURE_JSON")
  if [ -n "$GLOBAL_MEMORY_FAILURE_RUN_ID" ]; then
    sudo tail -n 80 "/var/lib/vm0-runner/logs/system-stream-${GLOBAL_MEMORY_FAILURE_RUN_ID}.log" >&2 || true
  fi
  fail "Guest-wide tool OOM did not preserve runtime and sibling"
fi
printf '%s\n' "$GLOBAL_MEMORY_RESULT"
GLOBAL_MEMORY_JSON=$(awk '/^\{/{line=$0} END{print line}' <<< "$GLOBAL_MEMORY_RESULT")
GLOBAL_MEMORY_RUN_ID=$(jq -r '.run_id // empty' <<< "$GLOBAL_MEMORY_JSON")
[ -n "$GLOBAL_MEMORY_RUN_ID" ] || fail "Guest-wide OOM result omitted run ID"
GLOBAL_MEMORY_LOG="/var/lib/vm0-runner/logs/system-stream-${GLOBAL_MEMORY_RUN_ID}.log"
if ! sudo grep -E -q 'parallel-shell-tool-oom-survived .*guest_wide=true memcg_ooms=0 trigger=sysrq' \
  "$GLOBAL_MEMORY_LOG"; then
  sudo tail -n 80 "$GLOBAL_MEMORY_LOG" >&2 || true
  fail "Guest-wide OOM scope or recovery was not verified"
fi
require_contained_tool_oom "$GLOBAL_MEMORY_LOG" "Guest-wide tool OOM was not classified as contained"
GLOBAL_REUSE_RESULT=$("$PROCESS_CONTAINMENT_SUBMIT" "$BIN_DIR" --group "$GROUP" \
  --chat-thread-id "$GLOBAL_MEMORY_THREAD_ID" \
  --session-id e2e-process-containment-global-memory \
  --feature-flag sandboxReuse=true --prompt 'true') \
  || fail "Guest-wide OOM did not preserve subsequent execution"
printf '%s\n' "$GLOBAL_REUSE_RESULT"
GLOBAL_REUSE_JSON=$(awk '/^\{/{line=$0} END{print line}' <<< "$GLOBAL_REUSE_RESULT")
GLOBAL_REUSE_RUN_ID=$(jq -r '.run_id // empty' <<< "$GLOBAL_REUSE_JSON")
[ -n "$GLOBAL_REUSE_RUN_ID" ] || fail "Guest-wide recovery omitted run ID"

for TASK_SCOPE in workload guest; do
  echo "--- Pressure: prefer nested managed tasks during ${TASK_SCOPE} OOM ---"
  TASK_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
  TASK_SESSION_ID="e2e-process-containment-task-${TASK_SCOPE}"
  if [ "$TASK_SCOPE" = guest ]; then
    TASK_OOM_PROMPT='@guest-wide-task-oom-injected'
    TASK_GUEST_WIDE=true
    TASK_TRIGGER=sysrq
    TASK_MEMCG_OOMS=0
  else
    TASK_OOM_PROMPT='@managed-task-oom'
    TASK_GUEST_WIDE=false
    TASK_TRIGGER=pressure
    TASK_MEMCG_OOMS='[1-9][0-9]*'
  fi
  if ! TASK_RESULT=$("$PROCESS_CONTAINMENT_SUBMIT" "$BIN_DIR" --group "$GROUP" \
    --chat-thread-id "$TASK_THREAD_ID" --session-id "$TASK_SESSION_ID" \
    --feature-flag sandboxReuse=true --prompt "$TASK_OOM_PROMPT"); then
    printf '%s\n' "$TASK_RESULT" >&2
    fail "nested task ${TASK_SCOPE} OOM did not preserve the main runtime"
  fi
  printf '%s\n' "$TASK_RESULT"
  TASK_JSON=$(awk '/^\{/{line=$0} END{print line}' <<< "$TASK_RESULT")
  TASK_RUN_ID=$(jq -r '.run_id // empty' <<< "$TASK_JSON")
  [ -n "$TASK_RUN_ID" ] || fail "task OOM result omitted run ID"
  TASK_LOG="/var/lib/vm0-runner/logs/system-stream-${TASK_RUN_ID}.log"
  if ! sudo grep -E -q "nested-managed-task-oom-survived .*guest_wide=${TASK_GUEST_WIDE} memcg_ooms=${TASK_MEMCG_OOMS} trigger=${TASK_TRIGGER} reclaimed_bytes=[1-9][0-9]*" "$TASK_LOG"; then
    sudo tail -n 80 "$TASK_LOG" >&2 || true
    fail "task family retirement, memory reclamation or OOM scope was not verified"
  fi
  require_contained_tool_oom "$TASK_LOG" "nested task ${TASK_SCOPE} OOM was not classified as contained"
  TASK_REUSE_RESULT=$("$PROCESS_CONTAINMENT_SUBMIT" "$BIN_DIR" --group "$GROUP" \
    --chat-thread-id "$TASK_THREAD_ID" --session-id "$TASK_SESSION_ID" \
    --feature-flag sandboxReuse=true --prompt 'true') \
    || fail "task OOM did not preserve subsequent session execution"
  printf '%s\n' "$TASK_REUSE_RESULT"
  TASK_REUSE_JSON=$(awk '/^\{/{line=$0} END{print line}' <<< "$TASK_REUSE_RESULT")
  TASK_REUSE_RUN_ID=$(jq -r '.run_id // empty' <<< "$TASK_REUSE_JSON")
  [ -n "$TASK_REUSE_RUN_ID" ] || fail "task OOM follow-up omitted run ID"
  TASK_REUSE_RUN_IDS+=("$TASK_REUSE_RUN_ID")
done

echo "--- Pressure: runtime remains eligible without managed tools ---"
if RUNTIME_OOM_RESULT=$("$PROCESS_CONTAINMENT_SUBMIT" "$BIN_DIR" --group "$GROUP" \
  --prompt '@runtime-only-oom'); then
  fail "runtime-only OOM incorrectly succeeded"
fi
printf '%s\n' "$RUNTIME_OOM_RESULT"
RUNTIME_OOM_JSON=$(awk '/^\{/{line=$0} END{print line}' <<< "$RUNTIME_OOM_RESULT")
[ "$(jq -r '.exit_code' <<< "$RUNTIME_OOM_JSON")" = 137 ] \
  || fail "runtime-only OOM did not report exit 137"
RUNTIME_OOM_RUN_ID=$(jq -r '.run_id // empty' <<< "$RUNTIME_OOM_JSON")
[ -n "$RUNTIME_OOM_RUN_ID" ] || fail "runtime-only OOM result omitted run ID"

echo "--- Pressure: exhaust workload PID capacity and reclaim descendants ---"
PID_CHAT_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
PID_SESSION_ID="e2e-process-containment-pids"
PID_PROMPT=$(
  cat << 'PROMPT'
sudo -n python3 - <<'PY'
import errno
import os
import pathlib
import signal
import time

marker = pathlib.Path("/tmp/vm0-process-containment")
marker.mkdir()
(marker / "pid-pressure-sandbox").touch()
relative = next(
    line.removeprefix("0::").strip()
    for line in pathlib.Path("/proc/self/cgroup").read_text().splitlines()
    if line.startswith("0::")
)
tool = pathlib.Path(f"/sys/fs/cgroup{relative}")
if tool.parent.name != "tools" or tool.parent.parent.name != "workload":
    raise RuntimeError(f"PID pressure is outside a Bash tool cgroup: {relative}")
tools = tool.parent
# Production leaves are uncapped until representative workload task counts are
# calibrated. This operation-local ceiling keeps the enforcement smoke fast.
(tools / "pids.max").write_text("64")
children = []
while True:
    try:
        pid = os.fork()
    except OSError as error:
        if error.errno != errno.EAGAIN:
            raise
        break
    if pid == 0:
        os.setsid()
        null = os.open("/dev/null", os.O_RDWR)
        for descriptor in (0, 1, 2):
            os.dup2(null, descriptor)
        if null > 2:
            os.close(null)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        while True:
            signal.pause()
    children.append(pid)

events = {}
for line in (tools / "pids.events").read_text().splitlines():
    key, value = line.split()
    events[key] = int(value)
if events.get("max", 0) == 0:
    raise RuntimeError("pids.max did not reject a workload fork")
print(f"pid-pressure-ready children={len(children)} max={events['max']}", flush=True)
time.sleep(2)
print(f"pid-pressure-complete children={len(children)}", flush=True)
PY
PROMPT
)
PID_RESULT=$("$PROCESS_CONTAINMENT_SUBMIT" "$BIN_DIR" --group "$GROUP" \
  --chat-thread-id "$PID_CHAT_THREAD_ID" \
  --session-id "$PID_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt "$PID_PROMPT" \
  --active-input 'after=1s,text=pid-pressure-control') \
  || fail "PID-pressure workload did not finalize"
printf '%s\n' "$PID_RESULT"
PID_RESULT_JSON=$(awk '/^\{/{line=$0} END{print line}' <<< "$PID_RESULT")
PID_RUN_ID=$(jq -r '.run_id // empty' <<< "$PID_RESULT_JSON")
[ -n "$PID_RUN_ID" ] || fail "PID-pressure result omitted run ID"
PID_STREAM_LOG="/var/lib/vm0-runner/logs/system-stream-${PID_RUN_ID}.log"
sudo grep -F -q 'pid-pressure-complete children=' "$PID_STREAM_LOG" \
  || fail "PID-pressure workload did not reach the cgroup limit"
sudo grep -E -q 'pids_max=[1-9][0-9]*' "$PID_STREAM_LOG" \
  || fail "PID-pressure diagnostics omitted the pids.max event"

echo "--- Pressure: prove PID-exhaustion cleanup preserved sandbox reuse ---"
"$PROCESS_CONTAINMENT_SUBMIT" "$BIN_DIR" --group "$GROUP" \
  --chat-thread-id "$PID_CHAT_THREAD_ID" \
  --session-id "$PID_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'test -f /tmp/vm0-process-containment/pid-pressure-sandbox' \
  || fail "PID-pressure cleanup did not preserve safe sandbox reuse"

LOGS=$(sudo journalctl --no-pager "_SYSTEMD_INVOCATION_ID=$INVOCATION_ID" 2>&1) \
  || fail "failed to read runner logs"
for TASK_REUSE_RUN_ID in "${TASK_REUSE_RUN_IDS[@]}"; do
  printf '%s\n' "$LOGS" \
    | grep -F "run_id=$TASK_REUSE_RUN_ID" \
    | grep -F 'job finished' | grep -F 'reused=true' > /dev/null \
    || fail "task OOM follow-up did not reuse its sandbox"
done
printf '%s\n' "$LOGS" \
  | grep -F "run_id=$GLOBAL_REUSE_RUN_ID" \
  | grep -F 'job finished' | grep -F 'reused=true' > /dev/null \
  || fail "Guest-wide OOM recovery did not reuse its sandbox"
printf '%s\n' "$LOGS" \
  | grep -F "run_id=$RUNTIME_OOM_RUN_ID" \
  | grep -F 'job execution failed' \
  | grep -F 'resource_failure_kind="guest_memory_oom_killed"' > /dev/null \
  || fail "runtime-only OOM lost genuine agent-OOM attribution"
printf '%s\n' "$LOGS" \
  | grep -F "run_id=$MEMORY_RUN_ID" \
  | grep -F 'job finished' \
    > /dev/null \
  || fail "missing successful memory-pressure terminal log"
if printf '%s\n' "$LOGS" \
  | grep -F "run_id=$MEMORY_RUN_ID" \
  | grep -F 'job execution failed' > /dev/null; then
  fail "memory-pressure run was reported as failed"
fi
printf '%s\n' "$LOGS" \
  | grep -F "run_id=$MEMORY_REUSE_RUN_ID" \
  | grep -F 'job finished' \
  | grep -F 'reused=true' \
    > /dev/null \
  || fail "tool-group OOM follow-up did not reuse its sandbox"
echo "PASS: Bash tool group OOM preserved the CLI, unrelated tool, and reuse"
echo "PASS: Guest-wide OOM preserved tool isolation and runtime-only OOM attribution"
echo "PASS: Bash tool pids.max cleanup preserved sandbox reuse"
