#!/usr/bin/env bash
set -euo pipefail

BIN_DIR=$1
JOB_REF=$2
SVC="${JOB_REF}-workspace-cache-promotion"
GROUP="vm0/workspace-cache-promotion-${JOB_REF}"
RUNNER_DIR="/var/lib/vm0-runner/runners/${SVC}"
GROUP_DIR="/var/lib/vm0-runner/groups/vm0/workspace-cache-promotion-${JOB_REF}"
RUN_KEY=$(cat /proc/sys/kernel/random/uuid)
UNIT="vm0-runner-${SVC}.service"
MAX_ATTEMPTS=3
PROMOTION_VERIFIED=false
SUBMIT_PID=""
WRITER_EXEC_PID=""
SANDBOX_ID=""
TURN1_INVOCATION_ID=""
PROMOTION_INVOCATION_ID=""
RESTORE_INVOCATION_ID=""

fail() { echo "FAIL: $1"; exit 1; }
wait_for_unit_inactive() {
  for _ in $(seq 1 30); do
    if ! sudo systemctl is-active --quiet "$UNIT"; then
      return 0
    fi
    sleep 1
  done
  fail "$UNIT is still active after stop"
}

stop_active_attempt() {
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force || true
  wait_for_unit_inactive
  if [ -n "$WRITER_EXEC_PID" ]; then
    kill "$WRITER_EXEC_PID" 2>/dev/null || true
    wait "$WRITER_EXEC_PID" 2>/dev/null || true
    WRITER_EXEC_PID=""
  fi
  if [ -n "$SUBMIT_PID" ]; then
    kill "$SUBMIT_PID" 2>/dev/null || true
    wait "$SUBMIT_PID" 2>/dev/null || true
    SUBMIT_PID=""
  fi
}

cleanup() {
  echo "--- Cleanup ---"
  stop_active_attempt
  sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
}
trap cleanup EXIT

for ((ATTEMPT = 1; ATTEMPT <= MAX_ATTEMPTS; ATTEMPT++)); do
  SESSION_ID="e2e-workspace-cache-promotion-session-${RUN_KEY}-${ATTEMPT}"
  CHAT_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
  SUBMIT_PID=""
  WRITER_EXEC_PID=""
  SANDBOX_ID=""
  TURN1_INVOCATION_ID=""
  PROMOTION_INVOCATION_ID=""
  RESTORE_INVOCATION_ID=""

  echo "--- Workspace cache promotion attempt ${ATTEMPT}/${MAX_ATTEMPTS} ---"
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
  wait_for_unit_inactive
  sudo rm -rf "$GROUP_DIR"

  echo "--- Starting runner ---"
  sudo "$BIN_DIR/runner" service start --name "$SVC" \
    --config "$RUNNER_DIR/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true

  for _ in $(seq 1 30); do
    TURN1_INVOCATION_ID=$(sudo systemctl show "$UNIT" \
      --property=InvocationID --value 2>/dev/null) || true
    [ -n "$TURN1_INVOCATION_ID" ] && break
    sleep 1
  done
  [ -n "$TURN1_INVOCATION_ID" ] || fail "turn 1 runner invocation ID unavailable"

  # Keep the supervised turn active while an independently owned runner exec
  # creates a live writer. Terminal private cleanup must reject that writer
  # rather than delete state while another workload can still access it.
  echo "--- Turn 1: create live workspace state ---"
  sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
    --chat-thread-id "$CHAT_THREAD_ID" \
    --session-id "$SESSION_ID" \
    --feature-flag sandboxReuse=true \
    --prompt 'set -eu
rm -f /tmp/vm0-workspace-cache-release
mkfifo /tmp/vm0-workspace-cache-release
printf "workspace-cache-marker\n" > /home/user/workspace/cache-marker
mkdir -p /home/user/workspace/nested
sudo mount -t tmpfs -o size=1m tmpfs /home/user/workspace/nested
sudo touch /home/user/workspace/nested/ephemeral
cat /tmp/vm0-workspace-cache-release >/dev/null' &
  SUBMIT_PID=$!

  echo "--- Waiting for active workspace sandbox ---"
  SANDBOX_READY=false
  for _ in $(seq 1 60); do
    if ! kill -0 "$SUBMIT_PID" 2>/dev/null; then
      wait "$SUBMIT_PID" 2>/dev/null || true
      SUBMIT_PID=""
      fail "Workspace cache turn 1 exited before setup completed"
    fi
    SANDBOX_ID=$(sudo jq -r '.active_runs[0].sandbox_id // empty' \
      "$RUNNER_DIR/status.json" 2>/dev/null || true)
    if [ -n "$SANDBOX_ID" ] \
      && sudo timeout 3 "$BIN_DIR/runner" exec --timeout 2 \
        --sandbox "$SANDBOX_ID" -- sh -c \
        'test -p /tmp/vm0-workspace-cache-release && test -f /home/user/workspace/nested/ephemeral' \
        2>/dev/null; then
      SANDBOX_READY=true
      break
    fi
    sleep 1
  done
  [ "$SANDBOX_READY" = true ] || fail "Active workspace sandbox was not ready after 60s"

  echo "--- Starting independent live workspace writer ---"
  sudo "$BIN_DIR/runner" exec --timeout 240 --sandbox "$SANDBOX_ID" -- sh -c \
    'cd /home/user/workspace && exec 3>>live-writer && printf "writer-start\n" >&3 && while :; do printf x >&3; sleep 0.05; done' &
  WRITER_EXEC_PID=$!

  set +e
  WRITER_PROBE_OUTPUT=$(sudo timeout 17 "$BIN_DIR/runner" exec --timeout 10 \
    --sandbox "$SANDBOX_ID" -- sh -c \
    'writer_attempt=0
while [ "$writer_attempt" -lt 50 ]; do
  writer_size=$(stat -c %s /home/user/workspace/live-writer 2>/dev/null || printf 0)
  if [ "$writer_size" -gt 13 ]; then
    exit 0
  fi
  writer_attempt=$((writer_attempt + 1))
  sleep 0.1
done
printf "Independent workspace writer did not become active within 5 seconds\n" >&2
exit 42' 2>&1)
  WRITER_PROBE_STATUS=$?
  set -e

  if [ "$WRITER_PROBE_STATUS" -ne 0 ]; then
    printf '%s\n' "$WRITER_PROBE_OUTPUT"

    CONTROL_DEADLINE=false
    if grep -F 'failed to connect to sandbox: connect timed out' \
      <<<"$WRITER_PROBE_OUTPUT" >/dev/null \
      || grep -F 'failed to connect to sandbox: request timed out' \
        <<<"$WRITER_PROBE_OUTPUT" >/dev/null \
      || grep -F 'exec failed: exec start timeout' \
        <<<"$WRITER_PROBE_OUTPUT" >/dev/null; then
      CONTROL_DEADLINE=true
    elif [ "$WRITER_PROBE_STATUS" -eq 124 ] \
      && ! grep -Fx 'Timeout' <<<"$WRITER_PROBE_OUTPUT" >/dev/null; then
      CONTROL_DEADLINE=true
    fi

    if [ "$CONTROL_DEADLINE" = true ]; then
      echo "--- Control exec diagnostics for invocation ${TURN1_INVOCATION_ID} ---"
      CONTROL_LINES=$(sudo journalctl --no-pager \
        "_SYSTEMD_INVOCATION_ID=$TURN1_INVOCATION_ID" 2>&1 \
        | grep -E 'control socket|exec operation|runner-exec' || true)
      if [ -n "$CONTROL_LINES" ]; then
        printf '%s\n' "$CONTROL_LINES"
      else
        echo "No control exec diagnostics found"
      fi

      if [ "$ATTEMPT" -eq "$MAX_ATTEMPTS" ]; then
        fail "Concurrent control exec remained unavailable after ${MAX_ATTEMPTS} attempts"
      fi

      echo "RETRY: concurrent control exec missed its deadline on attempt ${ATTEMPT}"
      stop_active_attempt
      continue
    fi

    if [ "$WRITER_PROBE_STATUS" -eq 42 ]; then
      fail "Independent workspace writer did not become active"
    fi
    if [ "$WRITER_PROBE_STATUS" -eq 124 ]; then
      fail "Independent workspace writer readiness command timed out in the guest"
    fi
    fail "Independent workspace writer readiness probe failed with status ${WRITER_PROBE_STATUS}"
  fi

  # Enter draining while both the supervised turn and independent writer are
  # live. Terminal preparation must fail closed before freeze/publication,
  # without changing the successful turn's outcome. Sandbox stop owns the writer.
  echo "--- Draining runner with a live writer ---"
  sudo "$BIN_DIR/runner" service drain --name "$SVC"
  kill -0 "$WRITER_EXEC_PID" 2>/dev/null \
    || fail "Independent workspace writer was not live before terminal preparation"
  sudo timeout 20 "$BIN_DIR/runner" exec --timeout 15 \
    --sandbox "$SANDBOX_ID" -- sh -c \
    'printf release > /tmp/vm0-workspace-cache-release' \
    || fail "Failed to release workspace cache turn 1"
  if ! wait "$SUBMIT_PID"; then
    SUBMIT_PID=""
    fail "Workspace cache turn 1 failed"
  fi
  SUBMIT_PID=""
  wait_for_unit_inactive
  wait "$WRITER_EXEC_PID" 2>/dev/null || true
  WRITER_EXEC_PID=""

  REJECTION_LOGS=$(sudo journalctl --no-pager \
    "_SYSTEMD_INVOCATION_ID=$TURN1_INVOCATION_ID" 2>&1) \
    || fail "failed to read live-writer terminal preparation logs"
  REJECTION_LINES=$(grep -F 'workspace image cache promotion skipped because guest preparation failed' \
    <<<"$REJECTION_LOGS" || true)
  if ! grep -F 'stale exec operation cgroup remains' <<<"$REJECTION_LINES" >/dev/null \
    || grep -F 'workspace image cache promoted' <<<"$REJECTION_LOGS" >/dev/null; then
    printf '%s\n' "$REJECTION_LOGS"
    fail "Live writer did not reject optional publication through process containment"
  fi
  echo "PASS: live writer rejected publication without failing the turn"

  # A new writer-free turn must miss the rejected candidate, then produce a
  # usable cache entry. Keep the positive freeze/nested-mount/restart contract;
  # do not make the native test pass merely by accepting every cache rejection.
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
  sudo "$BIN_DIR/runner" service start --name "$SVC" \
    --config "$RUNNER_DIR/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true
  for _ in $(seq 1 30); do
    PROMOTION_INVOCATION_ID=$(sudo systemctl show "$UNIT" \
      --property=InvocationID --value 2>/dev/null) || true
    if [ -n "$PROMOTION_INVOCATION_ID" ] \
      && [ "$PROMOTION_INVOCATION_ID" != "$TURN1_INVOCATION_ID" ]; then
      break
    fi
    PROMOTION_INVOCATION_ID=""
    sleep 1
  done
  [ -n "$PROMOTION_INVOCATION_ID" ] || fail "writer-free runner invocation ID unavailable"

  echo "--- Turn 2: create a writer-free cache candidate ---"
  if ! sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
    --chat-thread-id "$CHAT_THREAD_ID" \
    --session-id "$SESSION_ID" \
    --feature-flag sandboxReuse=true \
    --prompt 'set -eu
test ! -e /home/user/workspace/cache-marker
test ! -e /home/user/workspace/live-writer
printf "workspace-cache-marker\n" > /home/user/workspace/cache-marker
printf "completed-writer\n" > /home/user/workspace/live-writer
mkdir -p /home/user/workspace/nested
sudo mount -t tmpfs -o size=1m tmpfs /home/user/workspace/nested
sudo touch /home/user/workspace/nested/ephemeral'; then
    fail "Writer-free turn failed or restored the rejected live-writer candidate"
  fi
  sudo "$BIN_DIR/runner" service drain --name "$SVC"
  wait_for_unit_inactive
  PROMOTION_LOGS=$(sudo journalctl --no-pager \
    "_SYSTEMD_INVOCATION_ID=$PROMOTION_INVOCATION_ID" 2>&1) \
    || fail "failed to read writer-free workspace cache promotion logs"
  if grep -F 'workspace image cache promotion skipped: capacity lock busy' \
    <<<"$PROMOTION_LOGS" >/dev/null; then
    if [ "$ATTEMPT" -eq "$MAX_ATTEMPTS" ]; then
      fail "Workspace cache promotion capacity lock remained busy after ${MAX_ATTEMPTS} attempts"
    fi
    echo "RETRY: workspace cache promotion capacity lock was busy on attempt ${ATTEMPT}"
    continue
  fi
  if ! grep -F 'workspace image cache promoted' <<<"$PROMOTION_LOGS" >/dev/null; then
    printf '%s\n' "$PROMOTION_LOGS"
    fail "Writer-free turn did not publish a reusable cache entry"
  fi

  # Clear the drain drop-in before starting a fresh transient service.
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
  sudo "$BIN_DIR/runner" service start --name "$SVC" \
    --config "$RUNNER_DIR/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true

  # Scope restore diagnostics to the third runner, never an earlier invocation.
  for _ in $(seq 1 30); do
    RESTORE_INVOCATION_ID=$(sudo systemctl show "$UNIT" \
      --property=InvocationID --value 2>/dev/null) || true
    if [ -n "$RESTORE_INVOCATION_ID" ] \
      && [ "$RESTORE_INVOCATION_ID" != "$PROMOTION_INVOCATION_ID" ] \
      && [ "$RESTORE_INVOCATION_ID" != "$TURN1_INVOCATION_ID" ]; then
      break
    fi
    RESTORE_INVOCATION_ID=""
    sleep 1
  done
  [ -n "$RESTORE_INVOCATION_ID" ] || fail "restore runner invocation ID unavailable"

  echo "--- Turn 3: restore promoted workspace ---"
  if sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
    --chat-thread-id "$CHAT_THREAD_ID" \
    --session-id "$SESSION_ID" \
    --feature-flag sandboxReuse=true \
    --prompt 'test "$(cat /home/user/workspace/cache-marker)" = workspace-cache-marker && test "$(cat /home/user/workspace/live-writer)" = completed-writer && test ! -e /home/user/workspace/nested/ephemeral'; then
    echo "PASS: workspace cache restored after terminal cleanup and freeze-based promotion"
    PROMOTION_VERIFIED=true
    break
  fi

  RESTORE_LOGS=$(sudo journalctl --no-pager \
    "_SYSTEMD_INVOCATION_ID=$RESTORE_INVOCATION_ID" 2>&1) \
    || fail "failed to read workspace cache restore runner logs"
  if grep -F 'workspace image cache lock busy or unavailable; using fresh workspace image' \
    <<<"$RESTORE_LOGS" \
    | grep -F 'lock is already held by another process' >/dev/null; then
    if [ "$ATTEMPT" -eq "$MAX_ATTEMPTS" ]; then
      fail "Workspace cache restore entry lock remained busy after ${MAX_ATTEMPTS} attempts"
    fi
    echo "RETRY: workspace cache restore entry lock was busy on attempt ${ATTEMPT}"
    continue
  fi

  echo "--- Workspace cache logs for invocation ${RESTORE_INVOCATION_ID} ---"
  RESTORE_LINES=$(grep -F 'workspace image cache' <<<"$RESTORE_LOGS" || true)
  if [ -n "$RESTORE_LINES" ]; then
    printf '%s\n' "$RESTORE_LINES"
  else
    echo "No workspace image cache logs found"
  fi
  fail "Workspace cache turn 3: promoted workspace state was not restored correctly"
done

[ "$PROMOTION_VERIFIED" = true ] || fail "Workspace cache promotion was not verified"

sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
wait_for_unit_inactive
sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
trap - EXIT

echo "=== Workspace cache promotion test passed ==="
