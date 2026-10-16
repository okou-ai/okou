#!/usr/bin/env bash
set -euo pipefail

BIN_DIR=$1
JOB_REF=$2
SCENARIO_DIR=$3
SVC="${JOB_REF}-process-containment"
GROUP="vm0/process-containment-${JOB_REF}"
RUNNER_DIR="/var/lib/vm0-runner/runners/${SVC}"
GROUP_DIR="/var/lib/vm0-runner/groups/vm0/process-containment-${JOB_REF}"
UNIT="vm0-runner-${SVC}.service"
SCENARIO_WORKER=""
SCENARIO_SUBMIT=""

# Leave ordinary diagnostics/teardown headroom inside the durable owner's 270s.
read -r UPTIME_SECONDS _ < /proc/uptime
PROCESS_CONTAINMENT_DEADLINE_UPTIME_SECONDS=$((${UPTIME_SECONDS%%.*} + 240))

fail() {
  echo "FAIL: $1"
  exit 1
}

wait_for_unit_inactive() {
  local state
  for _ in $(seq 1 30); do
    state=$(sudo systemctl show "$UNIT" --property=ActiveState --value) || return 1
    case "$state" in
      inactive | failed) return 0 ;;
      active | activating | deactivating) ;;
      *)
        echo "FAIL: unknown service state: $state" >&2
        return 1
        ;;
    esac
    sleep 1
  done
  echo "FAIL: $UNIT is still active after stop" >&2
  return 1
}

dump_failure_diagnostics() {
  [ -n "${INVOCATION_ID:-}" ] || return 0
  local logs run_id
  local -a run_ids
  echo "--- Failed Runner invocation ${INVOCATION_ID} ---"
  # This disposable test service owns the logs. Never dump its configuration or
  # queued request bodies. Limit both time and retained output on every read.
  if ! logs=$(timeout 5s sudo journalctl --no-pager --output=cat --lines=120 \
    "_SYSTEMD_INVOCATION_ID=$INVOCATION_ID" 2>&1 | tail -c 32768); then
    echo 'Runner journal unavailable or incomplete' >&2
  fi
  printf '%s\n' "$logs"
  mapfile -t run_ids < <(printf '%s\n' "$logs" | python3 -c '
import re, sys
text = re.sub(r"\x1b\[[0-9;]*m", "", sys.stdin.read())
ids = re.findall(r"\brun_id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b", text)
print("\n".join(list(dict.fromkeys(reversed(ids)))[:3]))
')
  for run_id in "${run_ids[@]}"; do
    [ -n "$run_id" ] || continue
    echo "--- Guest system stream ${run_id} ---"
    timeout 5s sudo tail -n 60 "/var/lib/vm0-runner/logs/system-stream-${run_id}.log" 2>&1 \
      | tail -c 16384 || true
  done
}

cleanup() {
  local status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    dump_failure_diagnostics || true
  fi
  echo "--- Cleanup ---"
  if [ -n "$SCENARIO_WORKER" ]; then
    rm -f "$SCENARIO_WORKER" || true
  fi
  if [ -n "$SCENARIO_SUBMIT" ]; then
    rm -f "$SCENARIO_SUBMIT" || true
  fi
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force --cleanup partial-start || true
  if wait_for_unit_inactive; then
    sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR" || true
  else
    echo 'Retaining test state because Runner inactivity is unconfirmed' >&2
  fi
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

sudo "$BIN_DIR/runner" service stop --name "$SVC" --force --cleanup partial-start
wait_for_unit_inactive
sudo rm -rf "$GROUP_DIR"

echo "--- Starting runner ---"
sudo "$BIN_DIR/runner" service start --name "$SVC" \
  --config "$RUNNER_DIR/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true

for _ in $(seq 1 30); do
  INVOCATION_ID=$(sudo systemctl show "$UNIT" --property=InvocationID --value 2> /dev/null) || true
  [ -n "$INVOCATION_ID" ] && break
  sleep 1
done
[ -n "${INVOCATION_ID:-}" ] || fail "runner invocation ID unavailable"

# Runner config directories are root-private. Read staged bytes through sudo,
# then keep each interpreter's UID, environment and stdin with the durable owner.
SCENARIO_WORKER=$(mktemp)
SCENARIO_SUBMIT=$(mktemp)
sudo cat -- "$SCENARIO_DIR/submit.sh" | tee "$SCENARIO_SUBMIT" > /dev/null
chmod 700 "$SCENARIO_SUBMIT"
run_scenario() {
  local source=$1
  shift
  sudo cat -- "$SCENARIO_DIR/$source" | tee "$SCENARIO_WORKER" > /dev/null
  PROCESS_CONTAINMENT_SUBMIT="$SCENARIO_SUBMIT" \
    PROCESS_CONTAINMENT_DEADLINE_UPTIME_SECONDS="$PROCESS_CONTAINMENT_DEADLINE_UPTIME_SECONDS" \
    bash "$SCENARIO_WORKER" "$@"
}
run_scenario managed-tasks.sh "$BIN_DIR" "$GROUP"
run_scenario lifecycle.sh "$BIN_DIR" "$GROUP" "$RUNNER_DIR" "$GROUP_DIR"
run_scenario resource-pressure.sh "$BIN_DIR" "$GROUP" "$INVOCATION_ID"

sudo "$BIN_DIR/runner" service stop --name "$SVC" --force --cleanup partial-start
wait_for_unit_inactive
sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
rm -f "$SCENARIO_WORKER"
rm -f "$SCENARIO_SUBMIT"
trap - EXIT

echo "=== Process-containment test passed ==="
