#!/usr/bin/env bash
set -euo pipefail

# Native operations already require root; keep the fixture's host lock FDs in
# this worker so cleanup and the durable unit own their complete lifetime.
if [ "$EUID" -ne 0 ]; then
  exec sudo -- bash "$0" "$@"
fi

BIN_DIR=$1
JOB_REF=$2
SVC="${JOB_REF}-home-cache-promotion"
GROUP="vm0/home-cache-promotion-${JOB_REF}"
RUNNER_DIR="/var/lib/vm0-runner/runners/${SVC}"
GROUP_DIR="/var/lib/vm0-runner/groups/vm0/home-cache-promotion-${JOB_REF}"
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
ORIGINAL_CONFIG="${RUNNER_DIR}/home-cache-original.yaml"
ROOTFS_UPDATE_DIR="${RUNNER_DIR}/rootfs-update"
UPDATED_ROOTFS_HASH=""
UPDATED_SNAPSHOT_HASH=""
UPDATED_IMAGE_DIR=""
HOME_CACHE_PIN_FDS=()
HOME_CACHE_GC_FD=""

fail() { echo "FAIL: $1"; exit 1; }
hold_fixture_cache_locks() {
  local keys cache_key cache_fd
  keys=$(env RUST_LOG=off "$BIN_DIR/runner" home-image-cache list --json \
    | python3 -c 'import json, sys
entries = json.load(sys.stdin)["entries"]
keys = sorted(entry["cacheKey"] for entry in entries
              if entry.get("cacheScope") == sys.argv[1] and entry["status"] == "reusable")
if not keys:
    raise SystemExit("fixture has no reusable committed home")
print("\n".join(keys))' "$GROUP")
  while IFS= read -r cache_key; do
    [[ "$cache_key" =~ ^[0-9a-f]{64}$ ]] || fail "unsafe fixture cache key"
    exec {cache_fd}<>"/var/lib/vm0-runner/locks/home-image-cache-${cache_key}.lock"
    HOME_CACHE_PIN_FDS+=("$cache_fd")
    flock -n "$cache_fd" || fail "fixture cache lock is busy"
    echo "Pinned fixture home during rootfs build: $cache_key"
  done <<<"$keys"
}
release_fixture_cache_locks() {
  local cache_fd
  for cache_fd in "${HOME_CACHE_PIN_FDS[@]}"; do
    flock -u "$cache_fd"
    exec {cache_fd}>&-
  done
  HOME_CACHE_PIN_FDS=()
}
hold_restore_gc_lock() {
  # Exclude collectors before releasing entry pins so checkout can own its entry.
  exec {HOME_CACHE_GC_FD}<>"/var/lib/vm0-runner/locks/home-image-cache-routine-gc.lock"
  flock -w 10 "$HOME_CACHE_GC_FD" || fail "home cache routine GC lock unavailable for restore"
}
release_restore_gc_lock() {
  if [ -n "$HOME_CACHE_GC_FD" ]; then
    flock -u "$HOME_CACHE_GC_FD"
    exec {HOME_CACHE_GC_FD}>&-
    HOME_CACHE_GC_FD=""
  fi
}
cache_diagnostics() {
  sudo env RUST_LOG=off "$BIN_DIR/runner" home-image-cache list --json \
    | python3 -c 'import json, sys
snapshot = json.load(sys.stdin)
entries = [entry for entry in snapshot["entries"] if entry.get("cacheScope") == sys.argv[1]]
print(json.dumps({"phase": sys.argv[2], "fixtureEntries": entries}))' "$GROUP" "$1"
}
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
  release_restore_gc_lock
  stop_active_attempt
  release_fixture_cache_locks
  if [ -n "$UPDATED_IMAGE_DIR" ]; then
    sudo rm -rf "$UPDATED_IMAGE_DIR"
  fi
  sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
}
trap cleanup EXIT

sudo cp "$RUNNER_DIR/runner.yaml" "$ORIGINAL_CONFIG"

prepare_updated_rootfs() {
  if [ -z "$UPDATED_ROOTFS_HASH" ]; then
    local original_hash original_image updated_image build_hashes
    original_hash=$(sudo awk '$1 == "rootfs_hash:" {print $2}' "$ORIGINAL_CONFIG")
    [[ "$original_hash" =~ ^[0-9a-f]{64}$ ]] || fail "original rootfs hash unavailable"
    original_image="/var/lib/vm0-runner/images/${original_hash}/rootfs.ext4"
    sudo mkdir -p "$ROOTFS_UPDATE_DIR"
    sudo debugfs -R "dump /usr/local/bin/codex-mock ${ROOTFS_UPDATE_DIR}/codex-mock" "$original_image"
    sudo test -s "$ROOTFS_UPDATE_DIR/codex-mock" || fail "original codex mock unavailable"
    # Appending a fixture note preserves ELF execution while genuinely changing
    # installed guest bytes and the production builder's rootfs identity.
    printf '\n%s\n' "$RUN_KEY" | sudo tee -a "$ROOTFS_UPDATE_DIR/codex-mock" >/dev/null
    sudo chmod 755 "$ROOTFS_UPDATE_DIR/codex-mock"
    build_hashes=$(sudo "$BIN_DIR/runner" build --profile vm0/default \
      --codex-mock "$ROOTFS_UPDATE_DIR/codex-mock" --dry-run)
    UPDATED_ROOTFS_HASH=$(awk -F= '$1 == "rootfs_hash" {print $2}' <<<"$build_hashes")
    UPDATED_SNAPSHOT_HASH=$(awk -F= '$1 == "snapshot_hash" {print $2}' <<<"$build_hashes")
    [[ "$UPDATED_ROOTFS_HASH" =~ ^[0-9a-f]{64}$ ]] || fail "updated rootfs hash unavailable"
    [[ "$UPDATED_SNAPSHOT_HASH" =~ ^[0-9a-f]{64}$ ]] || fail "updated snapshot hash unavailable"
    [ "$UPDATED_ROOTFS_HASH" != "$original_hash" ] || fail "rootfs update did not change identity"
    updated_image="/var/lib/vm0-runner/images/${UPDATED_ROOTFS_HASH}/rootfs.ext4"
    # Cleanup owns only a directory created exclusively by this fixture, after
    # proving its identity differs from the shared original.
    sudo mkdir "$(dirname "$updated_image")"
    UPDATED_IMAGE_DIR=$(dirname "$updated_image")
    # Reuse the already-built system template without a second network build.
    # Only the fixture's unique rootfs copy is edited, never the shared original.
    sudo cp --reflink=auto --sparse=always "$original_image" "${updated_image}.staging"
    sudo debugfs -w -R 'rm /usr/local/bin/codex-mock' "${updated_image}.staging"
    sudo debugfs -w -R "write ${ROOTFS_UPDATE_DIR}/codex-mock /usr/local/bin/codex-mock" "${updated_image}.staging"
    sudo debugfs -w -R 'set_inode_field /usr/local/bin/codex-mock mode 0100755' "${updated_image}.staging"
    sudo debugfs -R "dump /usr/local/bin/codex-mock ${ROOTFS_UPDATE_DIR}/installed-codex-mock" "${updated_image}.staging"
    sudo cmp "$ROOTFS_UPDATE_DIR/codex-mock" "$ROOTFS_UPDATE_DIR/installed-codex-mock"
    if sudo test -f "/var/lib/vm0-runner/images/${original_hash}/okou-cli.json"; then
      sudo cp "/var/lib/vm0-runner/images/${original_hash}/okou-cli.json" \
        "$(dirname "$updated_image")/okou-cli.json"
    fi
    sudo mv "${updated_image}.staging" "$updated_image"
    # Build a fresh native VM snapshot from the changed disk, with the owning
    # production builder computing and validating its actual input identities.
    sudo "$BIN_DIR/runner" build --profile vm0/default \
      --codex-mock "$ROOTFS_UPDATE_DIR/codex-mock"
  fi
  sudo sed -E \
    -e "s/^([[:space:]]*rootfs_hash:).*/\\1 ${UPDATED_ROOTFS_HASH}/" \
    -e "s/^([[:space:]]*snapshot_hash:).*/\\1 ${UPDATED_SNAPSHOT_HASH}/" \
    "$ORIGINAL_CONFIG" | sudo tee "$RUNNER_DIR/runner.yaml" >/dev/null
}

for ((ATTEMPT = 1; ATTEMPT <= MAX_ATTEMPTS; ATTEMPT++)); do
  SESSION_ID="e2e-home-cache-promotion-session-${RUN_KEY}-${ATTEMPT}"
  CHAT_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
  SUBMIT_PID=""
  WRITER_EXEC_PID=""
  SANDBOX_ID=""
  TURN1_INVOCATION_ID=""
  PROMOTION_INVOCATION_ID=""
  RESTORE_INVOCATION_ID=""

  echo "--- Home cache promotion attempt ${ATTEMPT}/${MAX_ATTEMPTS} ---"
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
  wait_for_unit_inactive
  sudo cp "$ORIGINAL_CONFIG" "$RUNNER_DIR/runner.yaml"
  sudo rm -rf "$GROUP_DIR"

  echo "--- Starting runner ---"
  sudo "$BIN_DIR/runner" service start --name "$SVC" \
    --config "$RUNNER_DIR/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true \
    --env RUST_LOG=info,runner_lifecycle=debug

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
  echo "--- Turn 1: create live home state ---"
  sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
    --chat-thread-id "$CHAT_THREAD_ID" \
    --session-id "$SESSION_ID" \
    --feature-flag sandboxReuse=true \
    --prompt 'set -eu
rm -f /tmp/vm0-home-cache-release
mkfifo /tmp/vm0-home-cache-release
test "$(pwd)" = /home/user/workspace
printf "home-cache-marker\n" > /home/user/workspace/cache-marker
mkdir -p /home/user/.npm
printf "ordinary-home-state\n" > /home/user/home-cache-marker
printf "npm-home-state\n" > /home/user/.npm/home-cache-marker
mkdir -p /home/user/workspace/nested
sudo mount -t tmpfs -o size=1m tmpfs /home/user/workspace/nested
sudo touch /home/user/workspace/nested/ephemeral
cat /tmp/vm0-home-cache-release >/dev/null' &
  SUBMIT_PID=$!

  echo "--- Waiting for active home sandbox ---"
  SANDBOX_READY=false
  for _ in $(seq 1 60); do
    if ! kill -0 "$SUBMIT_PID" 2>/dev/null; then
      wait "$SUBMIT_PID" 2>/dev/null || true
      SUBMIT_PID=""
      fail "Home cache turn 1 exited before setup completed"
    fi
    SANDBOX_ID=$(sudo jq -r '.active_runs[0].sandbox_id // empty' \
      "$RUNNER_DIR/status.json" 2>/dev/null || true)
    if [ -n "$SANDBOX_ID" ] \
      && sudo timeout 3 "$BIN_DIR/runner" exec --timeout 2 \
        --sandbox "$SANDBOX_ID" -- sh -c \
        'test -p /tmp/vm0-home-cache-release && test -f /home/user/workspace/nested/ephemeral' \
        2>/dev/null; then
      SANDBOX_READY=true
      break
    fi
    sleep 1
  done
  [ "$SANDBOX_READY" = true ] || fail "Active home sandbox was not ready after 60s"

  echo "--- Starting independent live home writer ---"
  sudo "$BIN_DIR/runner" exec --timeout 240 --sandbox "$SANDBOX_ID" -- sh -c \
    'cd /home/user && exec 3>>live-writer && printf "writer-start\n" >&3 && while :; do printf x >&3; sleep 0.05; done' &
  WRITER_EXEC_PID=$!

  set +e
  WRITER_PROBE_OUTPUT=$(sudo timeout 17 "$BIN_DIR/runner" exec --timeout 10 \
    --sandbox "$SANDBOX_ID" -- sh -c \
    'writer_attempt=0
while [ "$writer_attempt" -lt 50 ]; do
  writer_size=$(stat -c %s /home/user/live-writer 2>/dev/null || printf 0)
  if [ "$writer_size" -gt 13 ]; then
    exit 0
  fi
  writer_attempt=$((writer_attempt + 1))
  sleep 0.1
done
printf "Independent home writer did not become active within 5 seconds\n" >&2
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
      fail "Independent home writer did not become active"
    fi
    if [ "$WRITER_PROBE_STATUS" -eq 124 ]; then
      fail "Independent home writer readiness command timed out in the guest"
    fi
    fail "Independent home writer readiness probe failed with status ${WRITER_PROBE_STATUS}"
  fi

  # Enter draining while both the supervised turn and independent writer are
  # live. Terminal preparation must fail closed before freeze/publication,
  # without changing the successful turn's outcome. Sandbox stop owns the writer.
  echo "--- Draining runner with a live writer ---"
  sudo "$BIN_DIR/runner" service drain --name "$SVC"
  kill -0 "$WRITER_EXEC_PID" 2>/dev/null \
    || fail "Independent home writer was not live before terminal preparation"
  sudo timeout 20 "$BIN_DIR/runner" exec --timeout 15 \
    --sandbox "$SANDBOX_ID" -- sh -c \
    'printf release > /tmp/vm0-home-cache-release' \
    || fail "Failed to release home cache turn 1"
  if ! wait "$SUBMIT_PID"; then
    SUBMIT_PID=""
    fail "Home cache turn 1 failed"
  fi
  SUBMIT_PID=""
  wait_for_unit_inactive
  wait "$WRITER_EXEC_PID" 2>/dev/null || true
  WRITER_EXEC_PID=""

  REJECTION_LOGS=$(sudo journalctl --no-pager \
    "_SYSTEMD_INVOCATION_ID=$TURN1_INVOCATION_ID" 2>&1) \
    || fail "failed to read live-writer terminal preparation logs"
  REJECTION_LINES=$(grep -F 'home image publication rejected because guest preparation failed' \
    <<<"$REJECTION_LOGS" || true)
  if ! grep -F 'stale exec operation cgroup remains' <<<"$REJECTION_LINES" >/dev/null \
    || grep -F 'home image cache promoted' <<<"$REJECTION_LOGS" >/dev/null; then
    printf '%s\n' "$REJECTION_LOGS"
    fail "Live writer did not reject optional publication through process containment"
  fi
  echo "PASS: live writer rejected publication without failing the turn"

  # A new writer-free turn must miss the rejected candidate, then produce a
  # usable cache entry. Keep the positive freeze/nested-mount/restart contract;
  # do not make the native test pass merely by accepting every cache rejection.
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
  sudo "$BIN_DIR/runner" service start --name "$SVC" \
    --config "$RUNNER_DIR/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true \
    --env RUST_LOG=info,runner_lifecycle=debug
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
test ! -e /home/user/live-writer
test ! -e /home/user/home-cache-marker
test ! -e /home/user/.npm/home-cache-marker
printf "home-cache-marker\n" > /home/user/workspace/cache-marker
printf "completed-writer\n" > /home/user/live-writer
test "$(pwd)" = /home/user/workspace
mkdir -p /home/user/.npm
printf "ordinary-home-state\n" > /home/user/home-cache-marker
printf "npm-home-state\n" > /home/user/.npm/home-cache-marker
mkdir -p /home/user/workspace/nested
sudo mount -t tmpfs -o size=1m tmpfs /home/user/workspace/nested
sudo touch /home/user/workspace/nested/ephemeral'; then
    fail "Writer-free turn failed or restored the rejected live-writer candidate"
  fi
  sudo "$BIN_DIR/runner" service drain --name "$SVC"
  wait_for_unit_inactive
  PROMOTION_LOGS=$(sudo journalctl --no-pager \
    "_SYSTEMD_INVOCATION_ID=$PROMOTION_INVOCATION_ID" 2>&1) \
    || fail "failed to read writer-free home cache promotion logs"
  if ! grep -F 'home image cache promoted' <<<"$PROMOTION_LOGS" >/dev/null; then
    printf '%s\n' "$PROMOTION_LOGS"
    fail "Writer-free turn did not publish a reusable cache entry"
  fi

  # Clear the drain drop-in before starting a fresh transient service.
  cache_diagnostics before-rootfs-update
  # Shared native hosts can still run outgoing formula-aware GC. Isolate this
  # restore assertion from the accepted rollout miss through Runner startup.
  hold_fixture_cache_locks
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
  prepare_updated_rootfs
  sudo "$BIN_DIR/runner" service start --name "$SVC" \
    --config "$RUNNER_DIR/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true \
    --env RUST_LOG=info,runner_lifecycle=debug

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

  hold_restore_gc_lock
  release_fixture_cache_locks
  cache_diagnostics after-rootfs-update

  echo "--- Turn 3: restore promoted home into updated rootfs ${UPDATED_ROOTFS_HASH} ---"
  # Keep the prompt literal so substitutions run in the restored guest.
  # shellcheck disable=SC2016
  if timeout --kill-after=5s 60s sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
    --chat-thread-id "$CHAT_THREAD_ID" \
    --session-id "$SESSION_ID" \
    --feature-flag sandboxReuse=true \
    --prompt 'set -eu
test "$(pwd)" = /home/user/workspace
test "$(cat /home/user/workspace/cache-marker)" = home-cache-marker
test "$(cat /home/user/live-writer)" = completed-writer
test "$(cat /home/user/home-cache-marker)" = ordinary-home-state
test "$(cat /home/user/.npm/home-cache-marker)" = npm-home-state
test ! -e /home/user/workspace/nested/ephemeral'; then
    release_restore_gc_lock
    echo "PASS: home cache restored across rootfs update after terminal cleanup and freeze-based promotion"
    PROMOTION_VERIFIED=true
    break
  fi
  release_restore_gc_lock

  RESTORE_LOGS=$(sudo journalctl --no-pager \
    "_SYSTEMD_INVOCATION_ID=$RESTORE_INVOCATION_ID" 2>&1) \
    || fail "failed to read home cache restore runner logs"
  if grep -E 'home image cache lock (remained busy|busy without retry); using fresh home image' \
    <<<"$RESTORE_LOGS" >/dev/null; then
    if [ "$ATTEMPT" -eq "$MAX_ATTEMPTS" ]; then
      fail "Home cache restore entry lock remained busy after ${MAX_ATTEMPTS} attempts"
    fi
    echo "RETRY: home cache restore entry lock was busy on attempt ${ATTEMPT}"
    continue
  fi

  echo "--- Home cache logs for invocation ${RESTORE_INVOCATION_ID} ---"
  RESTORE_LINES=$(grep -F 'home image cache' <<<"$RESTORE_LOGS" || true)
  if [ -n "$RESTORE_LINES" ]; then
    printf '%s\n' "$RESTORE_LINES"
  else
    echo "No home image cache logs found"
  fi
  fail "Home cache turn 3: promoted home state was not restored correctly"
done

[ "$PROMOTION_VERIFIED" = true ] || fail "Home cache promotion was not verified"

sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
wait_for_unit_inactive
if [ -n "$UPDATED_IMAGE_DIR" ]; then
  sudo rm -rf "$UPDATED_IMAGE_DIR"
fi
sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
trap - EXIT

echo "=== Home cache promotion test passed ==="
