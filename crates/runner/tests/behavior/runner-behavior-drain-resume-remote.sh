#!/usr/bin/env bash

BIN_DIR=$1; JOB_REF=$2
RUNNER_DIR="/var/lib/vm0-runner/runners/${JOB_REF}-drain"
SVC="${JOB_REF}-drain"
UNIT="vm0-runner-${SVC}.service"
DRAIN_DROP_IN="/run/systemd/system/${UNIT}.d/50-vm0-drain.conf"
GROUP="vm0/drain-${JOB_REF}"
GROUP_DIR="/var/lib/vm0-runner/groups/${GROUP}"
SUBMIT_A_PID=""
SUBMIT_B_PID=""
RELEASE_FIFO_READY=""

fail() { echo "FAIL: $1"; exit 1; }
status_mode() {
  sudo jq -r '.mode // empty' "$RUNNER_DIR/status.json" 2>/dev/null
}
restart_policy() {
  sudo systemctl show "$UNIT" --property=Restart --value 2>/dev/null
}

cleanup_submit_pid() {
  local pid=$1
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  echo "--- Cleanup ---"
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force || true
  cleanup_submit_pid "$SUBMIT_B_PID"
  cleanup_submit_pid "$SUBMIT_A_PID"
  sudo rm -rf -- "$GROUP_DIR"
}
trap cleanup EXIT

# Clean up residual service and queue state from previous CI attempts.
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
sudo rm -rf -- "$GROUP_DIR"

# Start transient runner service.
echo "--- Starting runner ---"
sudo "$BIN_DIR/runner" service start --name "$SVC" \
  --config "$RUNNER_DIR/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true

# Submit a host-released job in background so we can drain mid-flight.
# A fixed sleep would force CI to wait for the whole duration even
# after the drain/resume assertions finish.
echo "--- Submitting long-running job ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" --prompt 'rm -f /tmp/vm0-drain-release-a && mkfifo /tmp/vm0-drain-release-a && cat /tmp/vm0-drain-release-a >/dev/null && echo done' &
SUBMIT_A_PID=$!

# Wait for sandbox to appear in status.json.
echo "--- Waiting for sandbox ---"
for i in $(seq 1 60); do
  RUN_ID=$(sudo jq -r '.active_runs[0].run_id // empty' \
    "$RUNNER_DIR/status.json" 2>/dev/null)
  SANDBOX_ID=$(sudo jq -r '.active_runs[0].sandbox_id // empty' \
    "$RUNNER_DIR/status.json" 2>/dev/null)
  if [ -n "$RUN_ID" ] && [ -n "$SANDBOX_ID" ] \
    && sudo timeout 3 "$BIN_DIR/runner" exec --timeout 2 --sandbox "$SANDBOX_ID" -- test -p /tmp/vm0-drain-release-a 2>/dev/null; then
    RELEASE_FIFO_READY=1
    break
  fi
  sleep 1
done
[ -z "$RUN_ID" ] && fail "sandbox not found after 60s"
[ -z "$SANDBOX_ID" ] && fail "sandbox id not found after 60s"
[ -z "$RELEASE_FIFO_READY" ] && fail "release FIFO not ready after 60s"
echo "Found run $RUN_ID (sandbox $SANDBOX_ID)"

# Test 1: drain while the job is in-flight → mode=draining.
echo "--- Test: service drain (mid-flight) ---"
sudo "$BIN_DIR/runner" service drain --name "$SVC" || fail "drain command failed"

for i in $(seq 1 10); do
  [ "$(status_mode)" = "draining" ] && break
  sleep 1
done
[ "$(status_mode)" = "draining" ] \
  || fail "expected mode=draining, got '$(status_mode)'"
echo "PASS: mode=draining"

# Unit must still be active — the in-flight job keeps it alive.
sudo systemctl is-active --quiet "$UNIT" \
  || fail "unit should still be active during Draining"
RESTART_POLICY=$(restart_policy)
[ "$RESTART_POLICY" = "no" ] \
  || fail "expected Restart=no during drain, got '$RESTART_POLICY'"
[ -f "$DRAIN_DROP_IN" ] \
  || fail "expected drain drop-in at $DRAIN_DROP_IN"
echo "PASS: Restart=no applied during drain"

# Test 2: a job submitted *during* Draining must stay pending —
# the Draining arm does not poll discover, so the queued file
# should not be claimed until Running resumes.
echo "--- Test: submit during drain stays pending ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" --prompt 'echo B done' &
SUBMIT_B_PID=$!

# Continuously monitor for 10s that B stays pending (submit PID
# alive) and active_runs stays at 1 (A only). Sampling once after
# a fixed sleep can miss a transient claim-then-release bug; a
# continuous poll catches it at the iteration where the invariant
# breaks.
for i in $(seq 1 10); do
  if ! kill -0 "$SUBMIT_B_PID" 2>/dev/null; then
    fail "B submit completed at t=${i}s during Draining — runner should not claim new jobs"
  fi
  ACTIVE_COUNT=$(sudo jq -r '.active_runs | length' "$RUNNER_DIR/status.json" 2>/dev/null)
  [ "$ACTIVE_COUNT" = "1" ] \
    || fail "active_runs changed to '$ACTIVE_COUNT' at t=${i}s — runner claimed B during Draining"
  sleep 1
done
echo "PASS: B is pending, only A is active throughout 10s of Draining"

# Test 3: resume → mode=running.
echo "--- Test: service resume ---"
sudo "$BIN_DIR/runner" service resume --name "$SVC" || fail "resume command failed"

for i in $(seq 1 10); do
  [ "$(status_mode)" = "running" ] && break
  sleep 1
done
[ "$(status_mode)" = "running" ] \
  || fail "expected mode=running after resume, got '$(status_mode)'"
echo "PASS: mode=running after resume"
RESTART_POLICY=$(restart_policy)
[ "$RESTART_POLICY" = "on-failure" ] \
  || fail "expected Restart=on-failure after resume, got '$RESTART_POLICY'"
[ ! -e "$DRAIN_DROP_IN" ] \
  || fail "drain drop-in remained after resume at $DRAIN_DROP_IN"
echo "PASS: Restart policy restored after resume"

# Test 4: the pending B is picked up after resume and completes.
echo "--- Test: drain-era submit executes after resume ---"
SECONDS=0
wait "$SUBMIT_B_PID"
SUBMIT_B_EXIT=$?
SUBMIT_B_PID=""
B_ELAPSED=$SECONDS
echo "B exited with code $SUBMIT_B_EXIT in ${B_ELAPSED}s"
[ "$SUBMIT_B_EXIT" -eq 0 ] \
  || fail "B expected exit 0, got $SUBMIT_B_EXIT"
[ "$B_ELAPSED" -lt 60 ] \
  || fail "B took ${B_ELAPSED}s — discover did not resume properly"
echo "PASS: B completed after resume"

# Test 5: a fresh submit after resume also executes — confirms the
# runner is back to full operation, not just flushing the backlog.
echo "--- Test: fresh submit after resume executes ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" --prompt 'echo C done' \
  || fail "C submit failed after resume"
echo "PASS: fresh submit after resume completed"

# Test 6: the long-running A that straddled drain+resume finishes
# normally (exit 0) — drain must not cancel in-flight jobs.
echo "--- Test: A completes normally through drain+resume ---"
sudo timeout 20 "$BIN_DIR/runner" exec --timeout 15 --sandbox "$SANDBOX_ID" -- timeout 10 sh -c 'printf release > /tmp/vm0-drain-release-a' \
  || fail "failed to release A after drain+resume"
wait "$SUBMIT_A_PID"
SUBMIT_A_EXIT=$?
SUBMIT_A_PID=""
[ "$SUBMIT_A_EXIT" -eq 0 ] \
  || fail "A expected exit 0, got $SUBMIT_A_EXIT — job was killed"
echo "PASS: A completed normally through drain+resume"

# Test 7: drain on an idle runner → auto-Stop path. With no active
# jobs the Draining arm immediately commits to Stopping and the
# unit transitions to inactive.
echo "--- Test: drain with no jobs → auto-Stop ---"
sudo "$BIN_DIR/runner" service drain --name "$SVC" || fail "second drain failed"

for i in $(seq 1 30); do
  sudo systemctl is-active --quiet "$UNIT" || break
  sleep 1
done
if sudo systemctl is-active --quiet "$UNIT"; then
  fail "unit still active 30s after drain on idle runner"
fi
echo "PASS: unit stopped via auto-Stop"
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force \
  || fail "stop after idle drain failed"
[ ! -e "$DRAIN_DROP_IN" ] \
  || fail "drain drop-in remained after stop at $DRAIN_DROP_IN"
echo "PASS: stop cleaned drain drop-in"

# Test 8: resume refused on an inactive unit (is_unit_active guard).
echo "--- Test: resume refused after stop ---"
if sudo "$BIN_DIR/runner" service resume --name "$SVC" 2>&1; then
  fail "resume on inactive unit should have failed"
fi
echo "PASS: resume correctly refused on inactive unit"

trap - EXIT
echo "=== Drain + resume test passed ==="
