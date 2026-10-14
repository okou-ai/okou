#!/usr/bin/env bash
set -euo pipefail

BIN_DIR=$1
JOB_REF=$2
GROUP="vm0/systemd-reload-${JOB_REF}"
SVC_A="${JOB_REF}-systemd-reload-a"
SVC_B="${JOB_REF}-systemd-reload-b"
UNIT_A="vm0-runner-${SVC_A}.service"
UNIT_B="vm0-runner-${SVC_B}.service"
RUNNER_DIR_A="/var/lib/vm0-runner/runners/${SVC_A}"
RUNNER_DIR_B="/var/lib/vm0-runner/runners/${SVC_B}"
GROUP_DIR="/var/lib/vm0-runner/groups/${GROUP}"
INSTALL_A_PID=""
INSTALL_B_PID=""
UNINSTALL_A_PID=""
UNINSTALL_B_PID=""

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

wait_for_command() {
  local pid=$1 label=$2
  if ! wait "$pid"; then
    fail "$label failed"
  fi
}

cleanup_pid() {
  local pid=$1
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  local status=$?
  cleanup_pid "$UNINSTALL_B_PID"
  cleanup_pid "$UNINSTALL_A_PID"
  cleanup_pid "$INSTALL_B_PID"
  cleanup_pid "$INSTALL_A_PID"
  sudo "$BIN_DIR/runner" service uninstall --name "$SVC_A" --force >/dev/null 2>&1 || true
  sudo "$BIN_DIR/runner" service uninstall --name "$SVC_B" --force >/dev/null 2>&1 || true
  sudo rm -rf -- "$RUNNER_DIR_A" "$RUNNER_DIR_B" "$GROUP_DIR"
  if [ "$status" -ne 0 ]; then
    echo "--- systemd reload test journal ---"
    sudo journalctl -b --unit "$UNIT_A" --unit "$UNIT_B" --lines 100 --no-pager || true
    sudo journalctl -b _PID=1 --lines 100 --no-pager || true
  fi
}
trap cleanup EXIT

# Remove state from an interrupted attempt before opening the measurement
# window. The cleanup operations themselves are intentionally not counted.
sudo "$BIN_DIR/runner" service uninstall --name "$SVC_A" --force >/dev/null 2>&1 || true
sudo "$BIN_DIR/runner" service uninstall --name "$SVC_B" --force >/dev/null 2>&1 || true

[ -n "${RUNNER_BEHAVIOR_DURABLE_UNIT:-}" ] \
  || fail "durable execution unit is unavailable"
JOURNAL_CURSOR=$(sudo journalctl -b --no-pager -n 0 --show-cursor \
  | sed -n 's/^-- cursor: //p')
[ -n "$JOURNAL_CURSOR" ] || fail "could not capture journal cursor"

echo "--- Installing two different services concurrently ---"
sudo "$BIN_DIR/runner" service install --name "$SVC_A" \
  --config "$RUNNER_DIR_A/runner.yaml" --local \
  --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true &
INSTALL_A_PID=$!
sudo "$BIN_DIR/runner" service install --name "$SVC_B" \
  --config "$RUNNER_DIR_B/runner.yaml" --local \
  --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true &
INSTALL_B_PID=$!
wait_for_command "$INSTALL_A_PID" "install A"
INSTALL_A_PID=""
wait_for_command "$INSTALL_B_PID" "install B"
INSTALL_B_PID=""

for UNIT in "$UNIT_A" "$UNIT_B"; do
  [ "$(sudo systemctl show "$UNIT" --property=LoadState --value)" = "loaded" ] \
    || fail "$UNIT is not loaded after install"
  sudo systemctl is-enabled --quiet "$UNIT" \
    || fail "$UNIT is not enabled after install"
  sudo systemctl is-active --quiet "$UNIT" \
    || fail "$UNIT is not active after install"
done

echo "--- Uninstalling two different services concurrently ---"
sudo "$BIN_DIR/runner" service uninstall --name "$SVC_A" --force &
UNINSTALL_A_PID=$!
sudo "$BIN_DIR/runner" service uninstall --name "$SVC_B" --force &
UNINSTALL_B_PID=$!
wait_for_command "$UNINSTALL_A_PID" "uninstall A"
UNINSTALL_A_PID=""
wait_for_command "$UNINSTALL_B_PID" "uninstall B"
UNINSTALL_B_PID=""

for UNIT in "$UNIT_A" "$UNIT_B"; do
  if sudo systemctl is-active --quiet "$UNIT"; then
    fail "$UNIT remained active after uninstall"
  fi
  if sudo systemctl is-enabled --quiet "$UNIT"; then
    fail "$UNIT remained enabled after uninstall"
  fi
  [ ! -e "/etc/systemd/system/${UNIT}" ] \
    || fail "$UNIT file remained after uninstall"
  [ ! -e "/run/systemd/system/${UNIT}.d/50-vm0-drain.conf" ] \
    || fail "$UNIT drain override remained after uninstall"
  [ "$(sudo systemctl show "$UNIT" --property=LoadState --value)" = "not-found" ] \
    || fail "$UNIT remained loaded after uninstall"
done

REQUEST_SCOPE="unit ${RUNNER_BEHAVIOR_DURABLE_UNIT}"
RELOAD_COUNT=$(sudo journalctl -b _PID=1 --after-cursor="$JOURNAL_CURSOR" \
  --no-pager -o cat \
  | awk -v scope="$REQUEST_SCOPE" \
    'index($0, "Reloading requested") && index($0, scope) { count++ } END { print count + 0 }')

echo "Durable unit ${RUNNER_BEHAVIOR_DURABLE_UNIT} requested ${RELOAD_COUNT} systemd manager reload(s)"
# Another systemd client may absorb either completed lifecycle generation, so
# only this durable unit's upper bound is attributable.
[ "$RELOAD_COUNT" -le 4 ] \
  || fail "expected at most one reload per successful lifecycle operation, got $RELOAD_COUNT"

trap - EXIT
cleanup
echo "=== Systemd reload coordination test passed ==="
