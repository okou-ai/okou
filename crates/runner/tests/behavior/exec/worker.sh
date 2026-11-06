#!/usr/bin/env bash
set -euo pipefail

SCENARIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=network.sh
source "$SCENARIO_DIR/network.sh"
BIN_DIR=$1; JOB_REF=$2
RUNNER_DIR="/var/lib/vm0-runner/runners/${JOB_REF}-exec"
SVC="${JOB_REF}-exec"
UNIT="vm0-runner-${SVC}.service"
GROUP="vm0/exec-${JOB_REF}"
# Keep this distinct from startup readiness so NAT observes a new conntrack flow.
BEHAVIOR_DNS_DESTINATION="198.51.100.1"
STARTUP_TIMEOUT_SECS=120
STARTUP_LOG_LINES=300
STARTUP_CURSOR=""
STARTUP_ACTIVE_STATE=""
STARTUP_DIAGNOSTIC_LOGS=""
SUBMIT_PID=""
DNS_ISOLATION_NS=""
DNS_ISOLATION_HOST_IF=""
DNS_ISOLATION_LOCK_FD=""
SPOOF_NS=""
SPOOF_IP=""
POOL_LOCK_GUARD_DIR=""
POOL_LOCK_HOLDER_PID=""
POOL_LOCK_HOLDER_STATUS=""
POOL_LOCK_PUBLISH_RELEASE=""
POOL_LOCK_RELEASE_FD=""
POOL_LOCK_ERROR=""

fail() { echo "FAIL: $1"; exit 1; }

report_startup_diagnostics() {
  local readiness_status=$1 readiness_output=$2
  local unit_state invocation_id invocation_logs unit_logs

  echo "--- Runner readiness command ---"
  echo "Exit status: $readiness_status"
  printf '%s\n' "$readiness_output"

  if unit_state=$(sudo "$BIN_DIR/runner" service unit-state \
    --name "$SVC" 2>&1); then
    STARTUP_ACTIVE_STATE=$(printf '%s\n' "$unit_state" \
      | jq -r '.services[0].activeState // empty' 2>/dev/null) || true
  else
    unit_state="unit-state query failed: $unit_state"
  fi
  echo "--- Runner unit state ---"
  printf '%s\n' "$unit_state"

  if invocation_id=$(sudo systemctl show "$UNIT" \
    --property=InvocationID --value 2>&1); then
    if [ -n "$invocation_id" ]; then
      if ! invocation_logs=$(sudo journalctl --no-pager \
        --lines "$STARTUP_LOG_LINES" \
        "_SYSTEMD_INVOCATION_ID=$invocation_id" 2>&1); then
        invocation_logs="current invocation journal query failed: $invocation_logs"
      fi
    else
      invocation_logs="current invocation ID is empty"
    fi
  else
    invocation_logs="current invocation ID query failed: $invocation_id"
    invocation_id="unknown"
  fi
  echo "--- Current runner invocation: $invocation_id ---"
  printf '%s\n' "$invocation_logs"

  if ! unit_logs=$(sudo journalctl --no-pager \
    --lines "$STARTUP_LOG_LINES" --after-cursor="$STARTUP_CURSOR" \
    --unit "$UNIT" 2>&1); then
    unit_logs="post-start unit journal query failed: $unit_logs"
  fi
  echo "--- Runner unit journal after service start ---"
  printf '%s\n' "$unit_logs"

  STARTUP_DIAGNOSTIC_LOGS="${invocation_logs}
${unit_logs}"
}

cleanup_submit_pid() {
  local pid=$1
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  echo "--- Cleanup ---"
  cleanup_spoof_address
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force || true
  cleanup_pool_lock_guard
  cleanup_submit_pid "$SUBMIT_PID"
  if [ -n "$DNS_ISOLATION_NS" ]; then
    sudo ip netns delete "$DNS_ISOLATION_NS" 2>/dev/null || true
  fi
  if [ -n "$DNS_ISOLATION_HOST_IF" ]; then
    sudo ip link delete "$DNS_ISOLATION_HOST_IF" 2>/dev/null || true
  fi
  if [ -n "$DNS_ISOLATION_LOCK_FD" ]; then
    exec {DNS_ISOLATION_LOCK_FD}>&-
  fi
}
trap cleanup EXIT

# Clean up any residual transient unit from a previous CI run.
# stop() returns Ok when no service exists, so no need for || true.
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force

# Start transient runner service
echo "--- Starting runner ---"
STARTUP_CURSOR=$(sudo journalctl --no-pager --lines=1 --show-cursor \
  | sed -n 's/^-- cursor: //p') \
  || fail "failed to capture journal cursor before runner start"
[ -n "$STARTUP_CURSOR" ] \
  || fail "journal cursor missing before runner start"
sudo "$BIN_DIR/runner" service start --name "$SVC" \
  --config "$RUNNER_DIR/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true

# The runner publishes fresh mode=running only after namespace DNS activation.
# Keep the journal assertion below as independent functional-probe coverage.
if READINESS_OUTPUT=$(sudo "$BIN_DIR/runner" service wait-running \
  --name "$SVC" --timeout-secs "$STARTUP_TIMEOUT_SECS" 2>&1); then
  :
else
  READINESS_STATUS=$?
  report_startup_diagnostics "$READINESS_STATUS" "$READINESS_OUTPUT"
  if printf '%s\n' "$STARTUP_DIAGNOSTIC_LOGS" \
    | grep -E 'namespace DNS readiness probe failed|sandbox runtime DNS readiness' \
      >/dev/null; then
    fail "runner namespace DNS readiness failed during startup"
  fi
  case "$STARTUP_ACTIVE_STATE" in
    active | activating | reloading | refreshing)
      SERVICE_RUNNABLE=true
      ;;
    "")
      SERVICE_RUNNABLE=unknown
      ;;
    *)
      SERVICE_RUNNABLE=false
      ;;
  esac
  if [ "$SERVICE_RUNNABLE" = false ] \
    || printf '%s\n' "$READINESS_OUTPUT" \
      | grep -F "is not active while waiting for running" >/dev/null; then
    fail "runner service became non-runnable before reaching running (activeState=$STARTUP_ACTIVE_STATE)"
  fi
  if [ "$SERVICE_RUNNABLE" = true ] \
    && printf '%s\n' "$READINESS_OUTPUT" \
      | grep -F "timed out waiting ${STARTUP_TIMEOUT_SECS}s" >/dev/null; then
    fail "runner remained active past the ${STARTUP_TIMEOUT_SECS}s readiness deadline"
  fi
  fail "runner readiness check failed before reaching running"
fi

INVOCATION_ID=$(sudo systemctl show "$UNIT" \
  --property=InvocationID --value 2>/dev/null) \
  || fail "failed to read current runner invocation ID"
[ -n "$INVOCATION_ID" ] || fail "current runner invocation ID is empty"
STARTUP_LOGS=$(sudo journalctl --no-pager --lines "$STARTUP_LOG_LINES" \
  "_SYSTEMD_INVOCATION_ID=$INVOCATION_ID" 2>&1) \
  || fail "failed to read current runner startup logs"
if ! printf '%s\n' "$STARTUP_LOGS" \
  | grep -F "namespace DNS readiness probe succeeded" >/dev/null; then
  report_startup_diagnostics 0 \
    "runner reached running but the current invocation lacks the DNS readiness success marker"
  fail "current runner invocation did not log namespace DNS readiness success"
fi

exec_network_pre_submit

# Keep the sandbox active until the service-stop cleanup assertions run.
echo "--- Submitting long-running job ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --prompt 'rm -f /tmp/vm0-exec-keepalive && mkfifo /tmp/vm0-exec-keepalive && cat /tmp/vm0-exec-keepalive >/dev/null' &
SUBMIT_PID=$!

# Wait for OUR runner's sandbox to have a control socket.
# Read the sandbox_id from our runner's status.json (not from
# /run/vm0/sock/) to avoid matching sandboxes from parallel CI
# jobs (benchmark, upgrade). `runner exec` / socket paths are
# keyed by sandbox_id (#9552), which differs from run_id.
echo "--- Waiting for sandbox control socket ---"
for _ in $(seq 1 60); do
  SANDBOX_ID=$(sudo jq -r '.active_runs[0].sandbox_id // empty' \
    "$RUNNER_DIR/status.json" 2>/dev/null) || SANDBOX_ID=""
  [ -n "$SANDBOX_ID" ] && [ -S "/run/vm0/sock/$SANDBOX_ID/control.sock" ] && break
  SANDBOX_ID=""
  sleep 1
done
[ -z "$SANDBOX_ID" ] && fail "control socket not found after 60s"
echo "Found sandbox: $SANDBOX_ID"

# Independent scenarios share the captured binary and the same live sandbox.
for scenario in commands inventory postgres clients https; do
  "$SCENARIO_DIR/$scenario.sh" "$BIN_DIR" "$SANDBOX_ID"
done

# Carry the pre-submit network identity through live DNS and stop assertions.
exec_network_live_dns
exec_network_stop
trap - EXIT

echo "=== Exec test passed ==="
