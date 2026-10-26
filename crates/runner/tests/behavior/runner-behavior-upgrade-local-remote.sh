#!/usr/bin/env bash
set -euo pipefail

BIN_DIR=$1; JOB_REF=$2; GROUP="vm0/upgrade-${JOB_REF}"
RUNNER_DIR_A="/var/lib/vm0-runner/runners/${JOB_REF}-upgrade-a"
RUNNER_DIR_B="/var/lib/vm0-runner/runners/${JOB_REF}-upgrade-b"
SVC_A="${JOB_REF}-upgrade-a"
SVC_B="${JOB_REF}-upgrade-b"
SUBMIT1_PID=""
SUBMIT2_PID=""
GROUP_DIR="/var/lib/vm0-runner/groups/${GROUP}"
SYNC_DIR=""

# The request remains in the local queue until completion. Match this attempt's
# unique prompt, then require its exact claim/running mapping and guest FIFO.
# Neither an unrelated active run nor elapsed time establishes ownership.
wait_for_job_ready() {
  local prompt=$1 pid=$2 fifo=$3
  shift 3
  local runner_dir sandbox_id deadline=$((SECONDS + 60))
  local -a matches
  READY_RUN_ID=""
  READY_SANDBOX_ID=""
  for _ in $(seq 1 60); do
    kill -0 "$pid" 2>/dev/null || fail "submission exited before FIFO readiness"
    if [ -z "$READY_RUN_ID" ]; then
      mapfile -t matches < <(
        sudo find "$GROUP_DIR/jobs/vm0/default" -maxdepth 1 -type f -name '*.job' \
          -exec jq -r --arg prompt "$prompt" \
          'select(.prompt == $prompt) | .job_id | select(type == "string" and length > 0)' {} + 2>/dev/null
      )
      [ "${#matches[@]}" -le 1 ] || fail "ambiguous submission: ${#matches[@]} matching jobs"
      if [ "${#matches[@]}" -eq 1 ]; then
        READY_RUN_ID=${matches[0]}
      fi
    fi
    if [ -n "$READY_RUN_ID" ] && sudo test -f "$GROUP_DIR/claims/$READY_RUN_ID.claim"; then
      for runner_dir in "$@"; do
        sandbox_id=$(sudo jq -er --arg run_id "$READY_RUN_ID" \
          '[.active_runs[]? | select(.run_id == $run_id and .phase == "running")] |
           select(length == 1) | .[0].sandbox_id | select(type == "string" and length > 0)' \
          "$runner_dir/status.json" 2>/dev/null) || continue
        if sudo timeout 3 "$BIN_DIR/runner" exec --timeout 2 --sandbox "$sandbox_id" -- test -p "$fifo" 2>/dev/null; then
          kill -0 "$pid" 2>/dev/null || fail "submission exited during FIFO readiness"
          READY_SANDBOX_ID=$sandbox_id
          echo "PASS: run $READY_RUN_ID is running on ${runner_dir##*/} (sandbox $sandbox_id), FIFO ready"
          return 0
        fi
      done
    fi
    [ "$SECONDS" -lt "$deadline" ] || break
    sleep 1
  done
  fail "submission claim/running workload/FIFO not ready within observation budget"
}

release_job() {
  local sandbox_id=$1 fifo=$2
  sudo timeout 20 "$BIN_DIR/runner" exec --timeout 15 --sandbox "$sandbox_id" -- \
    timeout 10 sh -c 'printf release > "$1"' sh "$fifo" \
    || fail "failed to release workload in sandbox $sandbox_id"
}

wait_for_job_completion() {
  local pid=$1 run_id=$2 output=$3 deadline=$((SECONDS + 60))
  for _ in $(seq 1 60); do
    kill -0 "$pid" 2>/dev/null || break
    [ "$SECONDS" -lt "$deadline" ] || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    fail "submission $run_id did not finish after release"
  fi
  wait "$pid" || fail "submission $run_id failed"
  cat "$output"
  jq -e --arg run_id "$run_id" '.run_id == $run_id and .exit_code == 0' "$output" >/dev/null \
    || fail "submission result did not confirm success for $run_id"
}

fail() { echo "FAIL: $1"; exit 1; }

cleanup_submit_pid() {
  local pid=$1
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

# Poll `systemctl is-active` with a bounded budget; fail if the unit
# is still active afterward so the EXIT trap dumps journalctl at the
# right diagnostic boundary (instead of hanging inside systemctl stop).
wait_for_exit() {
  # Budget must exceed the 10s heartbeat tick — drain can only
  # complete on a tick boundary, so anything <10s has no headroom
  # for real teardown work (idle pool + namespace cleanup
  # + mitm/dns/kmsg shutdown). Shared metal-host contention can also make
  # namespace cleanup exceed 30s while it is still making progress, so allow
  # six heartbeat ticks before treating the drain as stuck. See issues #10869
  # and #13688.
  local svc=$1 budget=${2:-60}
  echo "--- Waiting up to ${budget}s for $svc to exit ---"
  for _ in $(seq 1 "$budget"); do
    systemctl is-active --quiet "vm0-runner-${svc}" || return 0
    sleep 1
  done
  # One final check covers units that exit during the last sleep.
  systemctl is-active --quiet "vm0-runner-${svc}" || return 0
  fail "$svc still active after ${budget}s (stuck on drain?)"
}

cleanup() {
  local status=$?
  echo "--- Cleanup: uninstalling services ---"
  sudo "$BIN_DIR/runner" service uninstall --name "$SVC_A" --force 2>/dev/null || true
  sudo "$BIN_DIR/runner" service uninstall --name "$SVC_B" --force 2>/dev/null || true
  cleanup_submit_pid "$SUBMIT2_PID"
  cleanup_submit_pid "$SUBMIT1_PID"
  if [ "$status" -ne 0 ]; then
    if [ -n "$SYNC_DIR" ]; then
      cat "$SYNC_DIR/job1.json" "$SYNC_DIR/job2.json" 2>/dev/null || true
    fi
    echo "--- Cleanup: dumping logs (test failed) ---"
    journalctl --unit "vm0-runner-${SVC_A}" --lines 50 --no-pager 2>/dev/null || true
    journalctl --unit "vm0-runner-${SVC_B}" --lines 50 --no-pager 2>/dev/null || true
  fi
  if [ -n "$SYNC_DIR" ]; then
    rm -rf -- "$SYNC_DIR" || true
  fi
}
trap cleanup EXIT

SYNC_DIR=$(mktemp -d /tmp/vm0-upgrade.XXXXXX) || fail "could not create submission result directory"
FIFO1="/tmp/${SYNC_DIR##*/}-job1"
FIFO2="/tmp/${SYNC_DIR##*/}-job2"
PROMPT1="rm -f $FIFO1 && mkfifo $FIFO1 && cat $FIFO1 >/dev/null && echo job1"
PROMPT2="rm -f $FIFO2 && mkfifo $FIFO2 && cat $FIFO2 >/dev/null && echo job2"

# Pre-cleanup: uninstall leftover services from previous CI runs
sudo "$BIN_DIR/runner" service uninstall --name "$SVC_A" --force 2>/dev/null || true
sudo "$BIN_DIR/runner" service uninstall --name "$SVC_B" --force 2>/dev/null || true

# 1. Install runner A
echo "--- Installing runner A ---"
sudo "$BIN_DIR/runner" service install --name "$SVC_A" \
  --config "$RUNNER_DIR_A/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true

# 2. Submit job 1 and establish that A owns its held workload before B starts.
echo "--- Submit job 1 (only A, host-released) ---"
exec {SUBMIT1_OUTPUT_FD}>"$SYNC_DIR/job1.json" || fail "could not open job 1 result file"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" --prompt "$PROMPT1" >&"$SUBMIT1_OUTPUT_FD" &
SUBMIT1_PID=$!
exec {SUBMIT1_OUTPUT_FD}>&-
wait_for_job_ready "$PROMPT1" "$SUBMIT1_PID" "$FIFO1" "$RUNNER_DIR_A"
RUN1_ID=$READY_RUN_ID
SANDBOX1_ID=$READY_SANDBOX_ID

# 3. Install runner B while job 1 still in-flight on A
echo "--- Installing runner B ---"
sudo "$BIN_DIR/runner" service install --name "$SVC_B" \
  --config "$RUNNER_DIR_B/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true

# 4. A and B compete for job 2; either may own it. Keep both jobs held.
echo "--- Submit job 2 (A and B compete, host-released) ---"
exec {SUBMIT2_OUTPUT_FD}>"$SYNC_DIR/job2.json" || fail "could not open job 2 result file"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" --prompt "$PROMPT2" >&"$SUBMIT2_OUTPUT_FD" &
SUBMIT2_PID=$!
exec {SUBMIT2_OUTPUT_FD}>&-
wait_for_job_ready "$PROMPT2" "$SUBMIT2_PID" "$FIFO2" "$RUNNER_DIR_A" "$RUNNER_DIR_B"
RUN2_ID=$READY_RUN_ID
SANDBOX2_ID=$READY_SANDBOX_ID
sudo systemctl is-active --quiet "vm0-runner-${SVC_A}" || fail "runner A exited before coexistence"
sudo systemctl is-active --quiet "vm0-runner-${SVC_B}" || fail "runner B is not active during coexistence"
kill -0 "$SUBMIT1_PID" 2>/dev/null || fail "job 1 exited before coexistence"

# 5. Observe drain with A's exact job 1 still running; only then release jobs.
echo "--- Draining runner A ---"
sudo "$BIN_DIR/runner" service drain --name "$SVC_A"
DRAIN_OBSERVED=false
DRAIN_DEADLINE=$((SECONDS + 10))
for _ in $(seq 1 10); do
  kill -0 "$SUBMIT1_PID" 2>/dev/null || fail "job 1 exited before drain observation"
  kill -0 "$SUBMIT2_PID" 2>/dev/null || fail "job 2 exited before drain observation"
  sudo systemctl is-active --quiet "vm0-runner-${SVC_A}" || fail "runner A exited with job 1 held"
  if sudo jq -e --arg run_id "$RUN1_ID" --arg sandbox_id "$SANDBOX1_ID" \
    '.mode == "draining" and any(.active_runs[]?;
      .run_id == $run_id and .sandbox_id == $sandbox_id and .phase == "running")' \
    "$RUNNER_DIR_A/status.json" >/dev/null 2>&1; then
    DRAIN_OBSERVED=true
    break
  fi
  [ "$SECONDS" -lt "$DRAIN_DEADLINE" ] || break
  sleep 1
done
[ "$DRAIN_OBSERVED" = true ] || fail "runner A did not retain job 1 while draining"
echo "PASS: runner A is draining with job 1 still running"
release_job "$SANDBOX1_ID" "$FIFO1"
release_job "$SANDBOX2_ID" "$FIFO2"

# 6. Verify both jobs complete despite drain
echo "--- Waiting for job 1 ---"
wait_for_job_completion "$SUBMIT1_PID" "$RUN1_ID" "$SYNC_DIR/job1.json"
SUBMIT1_PID=""
echo "--- Waiting for job 2 ---"
wait_for_job_completion "$SUBMIT2_PID" "$RUN2_ID" "$SYNC_DIR/job2.json"
SUBMIT2_PID=""

# 7. Wait for A to exit after drain, then verify drain still disables
# an inactive-but-enabled installed unit.
wait_for_exit "$SVC_A"
echo "--- Re-enable inactive runner A, then drain again ---"
sudo systemctl enable --no-reload "vm0-runner-${SVC_A}.service"
sudo systemctl is-enabled --quiet "vm0-runner-${SVC_A}.service" \
  || fail "runner A should be enabled before inactive drain"
sudo "$BIN_DIR/runner" service drain --name "$SVC_A" \
  || fail "inactive drain of runner A failed"
if sudo systemctl is-enabled --quiet "vm0-runner-${SVC_A}.service"; then
  fail "runner A remained enabled after inactive drain"
fi
echo "PASS: inactive drain disabled runner A"

echo "--- Uninstalling runner A ---"
sudo "$BIN_DIR/runner" service uninstall --name "$SVC_A" --force

# 8. Submit job 3 → only B is left
echo "--- Submit job 3 (only B) ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" --prompt 'echo job3' || fail "Job 3 failed"

# 9. Drain B, wait for it to exit, then uninstall
echo "--- Draining runner B ---"
sudo "$BIN_DIR/runner" service drain --name "$SVC_B"
wait_for_exit "$SVC_B"
echo "--- Uninstalling runner B ---"
sudo "$BIN_DIR/runner" service uninstall --name "$SVC_B" --force
rm -rf -- "$SYNC_DIR"
trap - EXIT

echo "=== Upgrade test passed ==="
