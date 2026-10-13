#!/usr/bin/env bash
set -euo pipefail

BIN_DIR=$1; JOB_REF=$2; SCENARIO_DIR=$3
SVC="${JOB_REF}-process-containment"
GROUP="vm0/process-containment-${JOB_REF}"
RUNNER_DIR="/var/lib/vm0-runner/runners/${SVC}"
GROUP_DIR="/var/lib/vm0-runner/groups/vm0/process-containment-${JOB_REF}"
UNIT="vm0-runner-${SVC}.service"
SCENARIO_WORKER=""

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

cleanup() {
  echo "--- Cleanup ---"
  if [ -n "$SCENARIO_WORKER" ]; then
    rm -f "$SCENARIO_WORKER"
  fi
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force || true
  wait_for_unit_inactive
  sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
wait_for_unit_inactive
sudo rm -rf "$GROUP_DIR"

echo "--- Starting runner ---"
sudo "$BIN_DIR/runner" service start --name "$SVC" \
  --config "$RUNNER_DIR/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true

for _ in $(seq 1 30); do
  INVOCATION_ID=$(sudo systemctl show "$UNIT" --property=InvocationID --value 2>/dev/null) || true
  [ -n "$INVOCATION_ID" ] && break
  sleep 1
done
[ -n "${INVOCATION_ID:-}" ] || fail "runner invocation ID unavailable"

# Runner config directories are root-private. Read staged bytes through sudo,
# then keep each interpreter's UID, environment and stdin with the durable owner.
SCENARIO_WORKER=$(mktemp)
run_scenario() {
  local source=$1
  shift
  sudo cat -- "$SCENARIO_DIR/$source" | tee "$SCENARIO_WORKER" > /dev/null
  bash "$SCENARIO_WORKER" "$@"
}
run_scenario managed-tasks.sh "$BIN_DIR" "$GROUP"
run_scenario lifecycle.sh "$BIN_DIR" "$GROUP" "$RUNNER_DIR" "$GROUP_DIR"
run_scenario resource-pressure.sh "$BIN_DIR" "$GROUP" "$INVOCATION_ID"

LOGS=$(sudo journalctl --no-pager "_SYSTEMD_INVOCATION_ID=$INVOCATION_ID" 2>&1) \
  || fail "failed to read runner logs"
if grep -F 'process control latency exceeded calibrated bound' <<<"$LOGS" >/dev/null; then
  fail "process control exceeded the calibrated 750ms bound under pressure"
fi

sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
wait_for_unit_inactive
sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
rm -f "$SCENARIO_WORKER"
trap - EXIT

echo "=== Process-containment test passed ==="
