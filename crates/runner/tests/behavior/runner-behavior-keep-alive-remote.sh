#!/usr/bin/env bash
set -euo pipefail

BIN_DIR=$1; JOB_REF=$2
SVC="${JOB_REF}-keepalive"
GROUP="vm0/keepalive-${JOB_REF}"
RUNNER_DIR="/var/lib/vm0-runner/runners/${SVC}"
GROUP_DIR="/var/lib/vm0-runner/groups/vm0/keepalive-${JOB_REF}"
UNIT="vm0-runner-${SVC}.service"
SESSION_ID="e2e-keepalive-test-session"
CHAT_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
ISOLATED_CHAT_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
TAMPER_CHAT_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
OVERLAP_CHAT_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
OVERLAP_SUBMIT_PID=""
OVERLAP_EXEC_PID=""

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
  if [ -n "$OVERLAP_EXEC_PID" ]; then
    kill "$OVERLAP_EXEC_PID" 2>/dev/null || true
    wait "$OVERLAP_EXEC_PID" 2>/dev/null || true
  fi
  if [ -n "$OVERLAP_SUBMIT_PID" ]; then
    kill "$OVERLAP_SUBMIT_PID" 2>/dev/null || true
    wait "$OVERLAP_SUBMIT_PID" 2>/dev/null || true
  fi
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force || true
  wait_for_unit_inactive
  sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
}
trap cleanup EXIT

# Clean up any residual transient unit or local queue files for this keep-alive runner.
# stop() returns Ok when no service exists, so no need for || true.
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
wait_for_unit_inactive
sudo rm -rf "$GROUP_DIR"

# Exercise the fixed helper against real guest mounts, before starting the
# multi-turn service. These checks are confined to one disposable benchmark VM.
echo "--- Home mount helper boundaries ---"
MOUNT_CHECKS=$(cat <<'GUEST_CHECKS'
set -eu
cd /tmp
helper=/sbin/guest-home-mount
home=/home/user
workspace=$home/workspace
account=$(printf '%s:%s' "$(id -u user)" "$(id -g user)")
expect_rejection() {
  if "$helper"; then
    echo "unsafe home accepted: $1" >&2
    exit 1
  fi
}

# The actual rebuilt Guest exposes the whole ext4 root, canonical cwd and shape.
"$helper"
test "$(findmnt -rn -o FSROOT --mountpoint "$home")" = /
test "$(mountpoint -d "$home")" = "$(mountpoint -x /dev/vdb)"
test "$(blockdev --getsize64 /dev/vdb)" -eq 25769803776
test "$(blockdev --getsize64 /dev/vda)" -eq 12884901888
test "$(stat -c %u:%g "$home")" = "$account"
test "$(stat -c %u:%g "$workspace")" = "$account"
test "$(cd "$workspace" && pwd)" = /home/user/workspace
for name in .bashrc .profile .bash_logout; do test -f "$home/$name"; done

# Only the home mount root may be repaired. Ordinary children and custom shell
# bytes remain intact; repeated and detached hits do not backfill used homes.
printf 'ordinary-home-marker\n' > "$home/owner-marker"
printf 'ordinary-cwd-marker\n' > "$workspace/cwd-marker"
printf 'custom shell bytes\n' > "$home/.bashrc"
rm "$home/.profile"
chown root:root "$home" "$home/owner-marker" "$workspace/cwd-marker"
"$helper"
test "$(stat -c %u:%g "$home")" = "$account"
test "$(stat -c %u:%g "$home/owner-marker")" = 0:0
test "$(stat -c %u:%g "$workspace/cwd-marker")" = 0:0
test "$(cat "$home/.bashrc")" = 'custom shell bytes'
test ! -e "$home/.profile"

# Unrelated mount targets may contain all four mountinfo path escapes.
escaped=$(mktemp -d "$(printf '/tmp/home space\tline\nbackslash\\.XXXXXX')")
mount -t tmpfs -o size=1m tmpfs "$escaped"
"$helper"
umount "$escaped"
rmdir "$escaped"

# Reattach populated ext4 after the rootfs mountpoint is absent. The hidden used
# rootfs home is not recursively copied into the persisted writable image.
umount "$home"
test ! -e /home/keepalive-owned-rootfs-home
printf 'must-not-be-copied\n' > "$home/rootfs-only-marker"
mv "$home" /home/keepalive-owned-rootfs-home
"$helper"
test -f "$home/owner-marker"
test -f "$workspace/cwd-marker"
test ! -e "$home/rootfs-only-marker"
test "$(cat "$home/.bashrc")" = 'custom shell bytes'
test ! -e "$home/.profile"

# Same-device subtree binds cannot stand in for the whole image. A complete-root
# bind is still revalidated by its current visible mount ID and device.
mkdir "$home/bind-source"
mount --bind "$home/bind-source" "$home"
expect_rejection same-device-subtree
umount "$home"
"$helper"
mount --bind "$home" "$home"
"$helper"
mount -t tmpfs -o size=1m tmpfs "$home"
expect_rejection stacked-tmpfs
umount "$home"
"$helper"
umount "$home"

outside=$(mktemp -d /tmp/home-mount-test.XXXXXX)
mount --move "$home" "$outside"
expect_rejection device-mounted-elsewhere
mount --move "$outside" "$home"
rmdir "$outside"

# Neither the target nor an ancestor may redirect containment elsewhere.
umount "$home"
rmdir "$home"
outside=$(mktemp -d /tmp/home-mount-symlink.XXXXXX)
ln -s "$outside" "$home"
expect_rejection symlink-target
test -z "$(ls -A "$outside")"
unlink "$home"
rmdir "$outside"
"$helper"
test ! -e /tmp/keepalive-owned-home-parent
mv /home /tmp/keepalive-owned-home-parent
ln -s /tmp/keepalive-owned-home-parent /home
expect_rejection symlink-parent
unlink /home
mv /tmp/keepalive-owned-home-parent /home
"$helper"

# Cwd must stay on the pinned home mount, without following or repairing an
# existing symlink, foreign mount, or incorrectly owned execution directory.
chown root:root "$workspace"
expect_rejection wrongly-owned-cwd
test "$(stat -c %u:%g "$workspace")" = 0:0
chown "$account" "$workspace"
mount -t tmpfs -o size=1m tmpfs "$workspace"
chown "$account" "$workspace"
expect_rejection foreign-cwd-mount
umount "$workspace"
mv "$workspace" "$home/kept-workspace"
ln -s /root "$workspace"
expect_rejection symlink-cwd
unlink "$workspace"
mv "$home/kept-workspace" "$workspace"
"$helper"

# Block-device and parse failures precede any mount or initialization effects.
unshare --mount --propagation private sh -eu -c '
  mount -t tmpfs -o size=1m tmpfs /dev
  touch /dev/vdb
  if /sbin/guest-home-mount; then exit 1; fi
  test -f /dev/vdb
'
unshare --mount --propagation private sh -eu -c '
  mount -t tmpfs -o size=1m tmpfs /proc
  mkdir /proc/self
  if /sbin/guest-home-mount; then exit 1; fi
  printf "invalid mount record\n" > /proc/self/mountinfo
  if /sbin/guest-home-mount; then exit 1; fi
  : > /proc/self/mountinfo
  if /sbin/guest-home-mount; then exit 1; fi
'
"$helper"
test "$(cat "$home/owner-marker")" = ordinary-home-marker
test "$(cat "$workspace/cwd-marker")" = ordinary-cwd-marker
# Destructive negative control is ONLY this disposable benchmark VM's attached
# home image, never a host disk, retained cache entry or existing user resource.
umount "$home"
chown root:root "$home"
dd if=/dev/zero of=/dev/vdb bs=1M count=4 conv=notrunc status=none
expect_rejection invalid-ext4
test "$(stat -c %u:%g "$home")" = 0:0
echo "PASS: native home mount boundaries"
GUEST_CHECKS
)
sudo "$BIN_DIR/runner" benchmark --config "$RUNNER_DIR/runner.yaml" \
  --profile vm0/default --sudo "$MOUNT_CHECKS" \
  || fail "Home mount helper boundaries failed"

# Start transient runner service
echo "--- Starting runner ---"
sudo "$BIN_DIR/runner" service start --name "$SVC" \
  --config "$RUNNER_DIR/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true

INVOCATION_ID=""
for _ in $(seq 1 30); do
  INVOCATION_ID=$(sudo systemctl show "$UNIT" \
    --property=InvocationID --value 2>/dev/null) || true
  [ -n "$INVOCATION_ID" ] && break
  sleep 1
done
[ -n "$INVOCATION_ID" ] || fail "runner invocation ID unavailable"

# Turn 1: submit a thread-bound job with provider session resume — creates a marker file in guest
echo "--- Turn 1: create marker file ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$CHAT_THREAD_ID" \
  --session-id "$SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'touch /tmp/keepalive-marker /home/user/keepalive-home-marker /home/user/workspace/keepalive-cwd-marker && echo turn1-done' \
  || fail "Turn 1 failed"

# Turn 2: submit with the same chat thread — should reuse the sandbox.
# If sandbox was reused, the marker file from turn 1 still exists (exit 0).
# If a new sandbox was created, the file is missing and test exits non-zero.
echo "--- Turn 2: verify marker file persists (sandbox reused) ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$CHAT_THREAD_ID" \
  --session-id "$SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'test -f /tmp/keepalive-marker && test -f /home/user/keepalive-home-marker && test -f /home/user/workspace/keepalive-cwd-marker' \
  || fail "Turn 2: marker file not found — sandbox was not reused"
echo "PASS: Turn 2 completed (sandbox reused, filesystem persisted)"

# Turn 3: keep the provider session but use a different chat thread — should create a new sandbox.
# The marker file must NOT exist in the new sandbox (thread isolation).
echo "--- Turn 3: different chat thread creates new sandbox ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$ISOLATED_CHAT_THREAD_ID" \
  --session-id "$SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'test ! -f /tmp/keepalive-marker && test ! -f /home/user/keepalive-home-marker && test ! -f /home/user/workspace/keepalive-cwd-marker' \
  || fail "Turn 3: marker file found — chat thread isolation broken"
echo "PASS: Turn 3 completed (new sandbox for different chat thread)"

# A privileged guest can stack an unrelated mount over the home after a
# turn starts. Idle admission must reject that sandbox; the next turn receives
# a fresh home mount backed by /dev/vdb.
TAMPER_SESSION_ID="e2e-keepalive-tampered-mount"
echo "--- Tamper turn 1: replace home mount before idle admission ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$TAMPER_CHAT_THREAD_ID" \
  --session-id "$TAMPER_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'set -eu
touch /tmp/keepalive-tampered-mount-marker
cd /tmp
sudo mount -t tmpfs -o size=1m tmpfs /home/user' \
  || fail "Tamper turn 1 failed"

echo "--- Tamper turn 2: rejected sandbox is replaced with a valid fresh mount ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$TAMPER_CHAT_THREAD_ID" \
  --session-id "$TAMPER_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'set -eu
test ! -f /tmp/keepalive-tampered-mount-marker
source=$(findmnt -rn -o SOURCE --target /home/user/workspace)
test "$(readlink -f "$source")" = /dev/vdb' \
  || fail "Tamper turn 2 reused an unsafe sandbox or exposed the wrong home device"
echo "PASS: tampered home mount was rejected before reuse"

# Hold an independently owned runner-exec normal operation while the supervised
# turn completes. The atomic final-operation reservation must fail busy, and the
# sandbox must be destroyed instead of entering the idle pool.
OVERLAP_SESSION_ID="e2e-keepalive-overlapping-exec"
echo "--- Overlap turn 1: hold supervised turn open ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$OVERLAP_CHAT_THREAD_ID" \
  --session-id "$OVERLAP_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'set -eu
touch /tmp/keepalive-overlap-marker
rm -f /tmp/keepalive-overlap-release
mkfifo /tmp/keepalive-overlap-release
cat /tmp/keepalive-overlap-release >/dev/null' &
OVERLAP_SUBMIT_PID=$!

OVERLAP_SANDBOX_ID=""
OVERLAP_READY=false
for _ in $(seq 1 60); do
  if ! kill -0 "$OVERLAP_SUBMIT_PID" 2>/dev/null; then
    wait "$OVERLAP_SUBMIT_PID" 2>/dev/null || true
    OVERLAP_SUBMIT_PID=""
    fail "Overlap turn 1 exited before setup completed"
  fi
  OVERLAP_SANDBOX_ID=$(sudo jq -r '.active_runs[0].sandbox_id // empty' \
    "$RUNNER_DIR/status.json" 2>/dev/null || true)
  if [ -n "$OVERLAP_SANDBOX_ID" ] \
    && sudo timeout 3 "$BIN_DIR/runner" exec --timeout 2 \
      --sandbox "$OVERLAP_SANDBOX_ID" -- test -p /tmp/keepalive-overlap-release \
      2>/dev/null; then
    OVERLAP_READY=true
    break
  fi
  sleep 1
done
[ "$OVERLAP_READY" = true ] || fail "Overlap turn sandbox was not ready after 60s"

echo "--- Starting independently owned runner exec ---"
sudo timeout 90 "$BIN_DIR/runner" exec --timeout 80 \
  --sandbox "$OVERLAP_SANDBOX_ID" -- sh -c \
  'rm -f /tmp/keepalive-overlap-exec-release
mkfifo /tmp/keepalive-overlap-exec-release
touch /tmp/keepalive-overlap-exec-ready
cat /tmp/keepalive-overlap-exec-release >/dev/null' &
OVERLAP_EXEC_PID=$!

EXEC_READY=false
for _ in $(seq 1 30); do
  if ! kill -0 "$OVERLAP_EXEC_PID" 2>/dev/null; then
    wait "$OVERLAP_EXEC_PID" 2>/dev/null || true
    OVERLAP_EXEC_PID=""
    fail "Independent runner exec exited before idle admission"
  fi
  if sudo timeout 3 "$BIN_DIR/runner" exec --timeout 2 \
    --sandbox "$OVERLAP_SANDBOX_ID" -- test -f /tmp/keepalive-overlap-exec-ready \
    2>/dev/null; then
    EXEC_READY=true
    break
  fi
  sleep 1
done
[ "$EXEC_READY" = true ] || fail "Independent runner exec did not become active"

sudo timeout 20 "$BIN_DIR/runner" exec --timeout 15 \
  --sandbox "$OVERLAP_SANDBOX_ID" -- sh -c \
  'printf release > /tmp/keepalive-overlap-release' \
  || fail "Failed to release overlap turn"
if ! wait "$OVERLAP_SUBMIT_PID"; then
  OVERLAP_SUBMIT_PID=""
  fail "Overlap turn 1 failed"
fi
OVERLAP_SUBMIT_PID=""

for _ in $(seq 1 20); do
  if ! kill -0 "$OVERLAP_EXEC_PID" 2>/dev/null; then
    break
  fi
  sleep 0.5
done
if kill -0 "$OVERLAP_EXEC_PID" 2>/dev/null; then
  kill "$OVERLAP_EXEC_PID" 2>/dev/null || true
  wait "$OVERLAP_EXEC_PID" 2>/dev/null || true
  OVERLAP_EXEC_PID=""
  fail "Independent runner exec remained alive after rejected sandbox destruction"
fi
wait "$OVERLAP_EXEC_PID" 2>/dev/null || true
OVERLAP_EXEC_PID=""

OVERLAP_BUSY_LOGGED=false
for _ in $(seq 1 10); do
  OVERLAP_LOGS=$(sudo journalctl --no-pager \
    "_SYSTEMD_INVOCATION_ID=$INVOCATION_ID" 2>&1) \
    || fail "failed to read overlap runner logs"
  if grep -F 'normal operations busy while preparing park' \
    <<<"$OVERLAP_LOGS" >/dev/null; then
    OVERLAP_BUSY_LOGGED=true
    break
  fi
  sleep 0.5
done
[ "$OVERLAP_BUSY_LOGGED" = true ] \
  || fail "overlapping runner exec did not reject idle admission as busy"

echo "--- Overlap turn 2: busy sandbox was not reused ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$OVERLAP_CHAT_THREAD_ID" \
  --session-id "$OVERLAP_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'set -eu
test ! -f /tmp/keepalive-overlap-marker
source=$(findmnt -rn -o SOURCE --target /home/user/workspace)
test "$(readlink -f "$source")" = /dev/vdb' \
  || fail "Overlap turn 2 reused the sandbox rejected by the final-operation fence"
echo "PASS: overlapping runner exec could not produce a reusable sandbox"

# Regression gate for sandbox_id/run_id conflation (#9552):
# at this point the runner has parked idle sandboxes whose FC workspace
# names (= sandbox_id) are divorced from any active run_id.
# `runner doctor --name <svc>` must still report 0 warnings.
# Scope to this CI run's runner name so that unrelated runners
# sharing the metal host don't contaminate the check.
echo "--- runner doctor --name $SVC (expect 0 warnings) ---"
DOCTOR_OUT=$(sudo "$BIN_DIR/runner" doctor --name "$SVC" 2>&1 || true)
echo "$DOCTOR_OUT"
if ! grep -q '^0 warning(s) found$' <<<"$DOCTOR_OUT"; then
  fail "runner doctor reported warnings with parked idle sandboxes — regression for #9552"
fi
echo "PASS: runner doctor clean with parked sandboxes"

# Stop transient service (drains idle pool)
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
wait_for_unit_inactive
sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
trap - EXIT

echo "=== Keep-alive test passed ==="
