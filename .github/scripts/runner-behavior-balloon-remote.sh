#!/usr/bin/env bash
set -euo pipefail

BIN_DIR=$1
JOB_REF=$2
RUNNER_DIR="/var/lib/vm0-runner/runners/${JOB_REF}-balloon"
SVC="${JOB_REF}-balloon"
GROUP="vm0/balloon-${JOB_REF}"
CHAT_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
SUBMIT_PID=""
ALLOC_PID=""
API_SOCK=""
FIRECRACKER_PID=""

fail() {
  echo "FAIL: $1"
  sudo curl -sf --max-time 3 --unix-socket "$API_SOCK" \
    http://localhost/balloon/statistics | jq . || true
  exit 1
}

cleanup() {
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force || true
  for pid in "$ALLOC_PID" "$SUBMIT_PID"; do
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT

sudo "$BIN_DIR/runner" service stop --name "$SVC" --force \
  || fail "failed to stop residual balloon service"
sudo "$BIN_DIR/runner" service start --name "$SVC" \
  --config "$RUNNER_DIR/runner.yaml" --local \
  --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true \
  || fail "failed to start balloon service"

ensure_submit_running() {
  if ! kill -0 "$SUBMIT_PID" 2>/dev/null; then
    wait "$SUBMIT_PID" 2>/dev/null || true
    SUBMIT_PID=""
    fail "keepalive job exited before assertions completed"
  fi
}

start_turn() {
  local prompt=$1
  sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
    --chat-thread-id "$CHAT_THREAD_ID" --prompt "$prompt" &
  SUBMIT_PID=$!
  local deadline=$(( SECONDS + 60 ))
  SANDBOX_ID=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    ensure_submit_running
    # Preparing entries may still refer to a paused reuse candidate.
    SANDBOX_ID=$(sudo jq -r '.active_runs[] | select(.phase == "running") | .sandbox_id' \
      "$RUNNER_DIR/status.json" 2>/dev/null) || true
    if [ -n "$SANDBOX_ID" ] && [ -S "/run/vm0/sock/$SANDBOX_ID/control.sock" ]; then
      API_SOCK="/run/vm0/sock/$SANDBOX_ID/api.sock"
      FIRECRACKER_PID=$(sudo ps -ww -C firecracker -o pid=,args= | awk -v socket="$API_SOCK" '
        { for (i = 2; i < NF; i++) if ($i == "--api-sock" && $(i + 1) == socket) { print $1; break } }')
      [[ "$FIRECRACKER_PID" =~ ^[0-9]+$ ]] \
        || fail "expected exactly one Firecracker process for the active sandbox"
      return
    fi
    sleep 1
  done
  fail "running sandbox control socket unavailable"
}

snapshot() {
  sudo curl -fsS --max-time 3 --unix-socket "$API_SOCK" \
    http://localhost/balloon/statistics | jq -er '
      [.target_pages, .actual_pages] as $v
      | select(all($v[]; type == "number" and . >= 0 and . == floor))
      | $v | @tsv'
}

rss_kib() {
  sudo awk '/^VmRSS:/ { print $2; found=1 } END { if (!found) exit 1 }' \
    "/proc/$FIRECRACKER_PID/status"
}

assert_active_capacity() {
  local deadline=$(( SECONDS + 12 ))
  local target actual sample
  # Cover more than two former controller intervals under each live condition.
  # Running means actual memory is already returned; do not wait away a defect.
  while [ "$SECONDS" -lt "$deadline" ]; do
    ensure_submit_running
    sample=$(snapshot) || fail "balloon statistics unavailable"
    IFS=$'\t' read -r target actual <<< "$sample"
    [[ "$target" -eq 0 && "$actual" -eq 0 ]] \
      || fail "active capacity changed: target=$target actual=$actual"
    sleep 2
  done
}

finish_turn() {
  sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" --timeout 5 -- \
    touch /tmp/balloon-test-finish || fail "failed to release keepalive"
  wait "$SUBMIT_PID" || fail "keepalive job failed"
  SUBMIT_PID=""
}

KEEPALIVE='for i in {1..180}; do test ! -f /tmp/balloon-test-finish || exit 0; sleep 1; done; exit 1'
# Read the real kernel accounting in the first tool command, before any sleep.
# A missing counter or any held balloon page fails the submitted job itself.
FIRST_MEMORY="uname -r; awk '/^(MemTotal|MemFree|MemAvailable|Balloon):/ { print } /^Balloon:/ { seen=1; if (\$2 != 0) exit 1 } END { if (!seen) exit 1 }' /proc/meminfo || exit 1"
start_turn "$FIRST_MEMORY; touch /tmp/balloon-test-marker; $KEEPALIVE"
FIRST_SANDBOX_ID=$SANDBOX_ID
sudo curl -fsS --max-time 3 --unix-socket "$API_SOCK" http://localhost/balloon \
  | jq -e '.free_page_reporting == true and .deflate_on_oom == true' \
  || fail "reporting and OOM deflation must stay enabled"
assert_active_capacity
echo "PASS: active idle Guest retains configured capacity with reporting enabled"

# Touch real anonymous pages, retain them while observing policy, then release.
sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" --timeout 60 -- \
  python3 -c '
import pathlib, time
data = bytearray(512 * 1024 * 1024)
for offset in range(0, len(data), 4096):
    data[offset] = 1
pathlib.Path("/tmp/balloon-alloc-ready").touch()
deadline = time.monotonic() + 45
while not pathlib.Path("/tmp/balloon-alloc-release").exists():
    if time.monotonic() >= deadline:
        raise TimeoutError("host did not release bounded allocation")
    time.sleep(0.1)
assert sum(data[::4096]) == len(data) // 4096
' &
ALLOC_PID=$!
for _ in $(seq 1 20); do
  kill -0 "$ALLOC_PID" 2>/dev/null || fail "allocator exited before readiness"
  if sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" --timeout 3 -- \
    test -f /tmp/balloon-alloc-ready; then
    break
  fi
  sleep 1
done
sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" --timeout 3 -- \
  test -f /tmp/balloon-alloc-ready || fail "allocator did not become ready"
assert_active_capacity
allocated_rss=$(rss_kib) || fail "allocated Guest RSS unavailable"
sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" --timeout 5 -- \
  touch /tmp/balloon-alloc-release || fail "failed to release allocator"
wait "$ALLOC_PID" || fail "bounded allocation failed"
ALLOC_PID=""
assert_active_capacity
echo "PASS: allocation and release retain active capacity"

# Verify real host backing return while the workload remains active. A partial
# 256-MiB drop leaves room for Guest/runtime cache; zero target alone proves no
# reclamation, and reporting does not promise to return every free page at once.
deadline=$(( SECONDS + 30 ))
while true; do
  ensure_submit_running
  sample=$(snapshot) || fail "balloon statistics unavailable during reporting"
  IFS=$'\t' read -r target actual <<< "$sample"
  [[ "$target" -eq 0 && "$actual" -eq 0 ]] \
    || fail "runtime reclamation used inflation: target=$target actual=$actual"
  reported_rss=$(rss_kib) || fail "released Guest RSS unavailable"
  if [ "$((allocated_rss - reported_rss))" -ge "$((256 * 1024))" ]; then
    break
  fi
  [ "$SECONDS" -lt "$deadline" ] \
    || fail "free-page reporting did not return backing: before=${allocated_rss}KiB after=${reported_rss}KiB"
  sleep 2
done
echo "PASS: running Guest returned backing (${allocated_rss}KiB -> ${reported_rss}KiB)"

finish_turn
deadline=$(( SECONDS + 30 ))
while ! sudo jq -e --arg id "$SANDBOX_ID" \
  'any(.idle_sandboxes[]?; .sandbox_id == $id)' "$RUNNER_DIR/status.json" >/dev/null; do
  [ "$SECONDS" -lt "$deadline" ] || fail "sandbox was not retained for reuse"
  sleep 1
done
sudo curl -fsS --max-time 3 --unix-socket "$API_SOCK" http://localhost/ \
  | jq -e '.state == "Paused"' || fail "parked Guest vCPUs are not paused"
sample=$(snapshot) || fail "parked balloon statistics unavailable"
IFS=$'\t' read -r target actual <<< "$sample"
[[ "$target" -eq 0 && "$actual" -eq 0 ]] \
  || fail "park paused before deflation completed: target=$target actual=$actual"
# Deflation restores Guest capacity without repopulating reclaimed host pages.
# Allow 128 MiB for finalization/kernel activity, but retain the earlier proof
# that at least 256 MiB of the touched allocation has returned to the host.
parked_rss=$(rss_kib) || fail "parked Guest RSS unavailable"
[ "$parked_rss" -le "$((reported_rss + 128 * 1024))" ] \
  || fail "park deflation repopulated backing: before=${reported_rss}KiB parked=${parked_rss}KiB"
[ "$((allocated_rss - parked_rss))" -ge "$((256 * 1024))" ] \
  || fail "park did not retain reclaimed backing: allocated=${allocated_rss}KiB parked=${parked_rss}KiB"
echo "PASS: parked Guest is deflated and paused with reclaimed backing (${reported_rss}KiB -> ${parked_rss}KiB)"

start_turn "$FIRST_MEMORY; test -f /tmp/balloon-test-marker || exit 1; rm /tmp/balloon-test-finish || exit 1; $KEEPALIVE"
[ "$SANDBOX_ID" = "$FIRST_SANDBOX_ID" ] || fail "second turn did not reuse sandbox"
assert_active_capacity
finish_turn
echo "PASS: reused Guest returns to active capacity"
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force \
  || fail "failed to stop balloon service"
trap - EXIT
echo "=== Balloon test passed ==="
