#!/usr/bin/env bash
set -euo pipefail

BIN_DIR=$1; JOB_REF=$2
SVC="${JOB_REF}-cancel"
RUNNER_DIR="/var/lib/vm0-runner/runners/${SVC}"
GROUP="vm0/cancel-${JOB_REF}"
GROUP_DIR="/var/lib/vm0-runner/groups/${GROUP}"
SUBMIT_PID=""
SUBMIT_OUTPUT=$(mktemp)
RECONCILE_TEST_DIR=$(mktemp -d "/tmp/vm0-${SVC}-reconcile.XXXXXX")
RECONCILE_BIN_DIR="$RECONCILE_TEST_DIR/bin"
RECONCILE_COUNT_DIR="$RECONCILE_TEST_DIR/counts"
RECONCILE_LOCK_INFO="$RECONCILE_TEST_DIR/pool-indexes"
RECONCILE_CAPACITY_RELEASE="$RECONCILE_TEST_DIR/release-capacity"
RECONCILE_CAPACITY_RELEASED="$RECONCILE_TEST_DIR/capacity-released"
RECONCILE_IDLE_RELEASE="$RECONCILE_TEST_DIR/release-idle"
RECONCILE_IDLE_RELEASED="$RECONCILE_TEST_DIR/idle-released"
RECONCILE_ACTIVE_RELEASE="$RECONCILE_TEST_DIR/release-active"
RECONCILE_FIREWALL_DELETE_STARTED="$RECONCILE_TEST_DIR/firewall-delete-started"
RECONCILE_FIREWALL_DELETE_RELEASE="$RECONCILE_TEST_DIR/release-firewall-delete"
RECONCILE_LOCK_HOLDER_ERROR="$RECONCILE_TEST_DIR/lock-holder-error"
RECONCILE_LOCK_HOLDER_STATUS="$RECONCILE_TEST_DIR/lock-holder-status"
RECONCILE_LOCK_PUBLISH_READY="$RECONCILE_TEST_DIR/lock-publish-ready"
RECONCILE_LOCK_PUBLISH_RELEASE="$RECONCILE_TEST_DIR/release-lock-publish"
RECONCILE_REQUIRED_POOL_INDEXES=5
RECONCILE_CAPACITY_TIMEOUT_SECONDS=60
RECONCILE_LOCK_HOLDER_PID=""

fail() { echo "FAIL: $1"; exit 1; }

print_service_logs() {
  echo "--- ${SVC} service logs ---"
  sudo "$BIN_DIR/runner" service logs --name "$SVC" --lines 200 || true
}

cleanup_submit_pid() {
  local pid=$1
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  local status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    print_service_logs
  fi
  sudo touch \
    "$RECONCILE_LOCK_PUBLISH_RELEASE" \
    "$RECONCILE_CAPACITY_RELEASE" \
    "$RECONCILE_IDLE_RELEASE" \
    "$RECONCILE_ACTIVE_RELEASE" \
    "$RECONCILE_FIREWALL_DELETE_RELEASE"
  echo "--- Cleanup ---"
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force || true
  cleanup_submit_pid "$SUBMIT_PID"
  sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
  rm -f "$SUBMIT_OUTPUT"
  if [ -n "$RECONCILE_LOCK_HOLDER_PID" ]; then
    wait "$RECONCILE_LOCK_HOLDER_PID" 2>/dev/null || true
  fi
  sudo rm -rf "$RECONCILE_TEST_DIR"
  exit "$status"
}
trap cleanup EXIT

mkdir -p "$RECONCILE_BIN_DIR" "$RECONCILE_COUNT_DIR"
REAL_IP=$(command -v ip)
REAL_IPTABLES=$(command -v iptables)
REAL_IPTABLES_SAVE=$(command -v iptables-save)
REAL_IPTABLES_RESTORE=$(command -v iptables-restore)
REAL_IP6TABLES_SAVE=$(command -v ip6tables-save)
REAL_IP6TABLES_RESTORE=$(command -v ip6tables-restore)

# Reserve five pool indexes before the runner starts. Four back the existing
# reconciliation fixture, while the fifth holds capacity for the runner
# startup handoff. Incomplete attempts release every lock before retrying.
# A stable supervisor publishes the privileged helper's terminal status;
# sudo's process identity is not part of the lifecycle protocol.
(
  lock_holder_status=0
  sudo bash -s -- \
    "$RECONCILE_LOCK_INFO" \
    "$RECONCILE_LOCK_PUBLISH_READY" \
    "$RECONCILE_LOCK_PUBLISH_RELEASE" \
    "$RECONCILE_CAPACITY_RELEASE" \
    "$RECONCILE_CAPACITY_RELEASED" \
    "$RECONCILE_IDLE_RELEASE" \
    "$RECONCILE_IDLE_RELEASED" \
    "$RECONCILE_ACTIVE_RELEASE" \
    "$RECONCILE_REQUIRED_POOL_INDEXES" \
    "$RECONCILE_CAPACITY_TIMEOUT_SECONDS" \
    <<'LOCK_HOLDER' || lock_holder_status=$?
set -euo pipefail
LOCK_INFO=$1
LOCK_PUBLISH_READY=$2
LOCK_PUBLISH_RELEASE=$3
CAPACITY_RELEASE=$4
CAPACITY_RELEASED=$5
IDLE_RELEASE=$6
IDLE_RELEASED=$7
ACTIVE_RELEASE=$8
REQUIRED_POOL_INDEXES=$9
CAPACITY_TIMEOUT_SECONDS=${10}
declare -a RESERVED_FDS=()
declare -a FIXTURE_FDS=()
declare -a RESERVED_INDEXES=()

reserve_index() {
  local index=$1
  local path="/var/lock/vm0-netns-pool-${index}.lock"
  local fixture_path="/var/lock/vm0-ci-cancel-pool-${index}.lock"
  local candidate_fd fixture_fd
  # Kernel locks are deliberately released during reconciliation. Keep a
  # separate CI claim until this helper exits so another cancel fixture cannot
  # reserve that same index during the handoff. Never unlink these lock files.
  exec {fixture_fd}>>"$fixture_path"
  if ! flock -n "$fixture_fd"; then
    exec {fixture_fd}>&-
    return 0
  fi
  exec {candidate_fd}>>"$path"
  if flock -n "$candidate_fd"; then
    RESERVED_FDS+=("$candidate_fd")
    FIXTURE_FDS+=("$fixture_fd")
    RESERVED_INDEXES+=("$index")
  else
    exec {candidate_fd}>&-
    exec {fixture_fd}>&-
  fi
}

release_reserved_indexes() {
  local fd
  for fd in "${RESERVED_FDS[@]}" "${FIXTURE_FDS[@]}"; do
    exec {fd}>&-
  done
  RESERVED_FDS=()
  FIXTURE_FDS=()
  RESERVED_INDEXES=()
}

CAPACITY_DEADLINE=$((SECONDS + CAPACITY_TIMEOUT_SECONDS))
LAST_ACQUIRED=0
while true; do
  # Prefer existing persistent lock files. Create new files only if the host
  # has fewer than five idle indexes available.
  for index in $(seq 63 -1 0); do
    [ -e "/var/lock/vm0-netns-pool-${index}.lock" ] || continue
    reserve_index "$index"
    [ "${#RESERVED_INDEXES[@]}" -eq "$REQUIRED_POOL_INDEXES" ] && break
  done
  if [ "${#RESERVED_INDEXES[@]}" -lt "$REQUIRED_POOL_INDEXES" ]; then
    for index in $(seq 63 -1 0); do
      [ -e "/var/lock/vm0-netns-pool-${index}.lock" ] && continue
      reserve_index "$index"
      [ "${#RESERVED_INDEXES[@]}" -eq "$REQUIRED_POOL_INDEXES" ] && break
    done
  fi
  LAST_ACQUIRED=${#RESERVED_INDEXES[@]}
  if [ "$LAST_ACQUIRED" -eq "$REQUIRED_POOL_INDEXES" ]; then
    break
  fi

  release_reserved_indexes
  [ ! -e "$CAPACITY_RELEASE" ] || exit 0
  if [ "$SECONDS" -ge "$CAPACITY_DEADLINE" ]; then
    echo "timed out after ${CAPACITY_TIMEOUT_SECONDS}s waiting for namespace pool capacity: required ${REQUIRED_POOL_INDEXES} indexes, acquired ${LAST_ACQUIRED} on last attempt" >&2
    exit 1
  fi
  sleep 1
done

# Only the first four indexes belong to the reconciliation fixture. Retain the
# fifth lock until the parent has created the transient runner service.
# Wait for the parent to observe this ready state before publishing the pool
# indexes so every run exercises delayed helper readiness.
touch "$LOCK_PUBLISH_READY"
while [ ! -e "$LOCK_PUBLISH_RELEASE" ]; do sleep 0.05; done
printf '%s\n' "${RESERVED_INDEXES[@]:0:4}" >"$LOCK_INFO"

while [ ! -e "$CAPACITY_RELEASE" ]; do sleep 0.05; done
CAPACITY_FD=${RESERVED_FDS[4]}
flock -u "$CAPACITY_FD"
exec {CAPACITY_FD}>&-
touch "$CAPACITY_RELEASED"

while [ ! -e "$IDLE_RELEASE" ]; do sleep 0.05; done
for position in 0 1 2; do
  flock -u "${RESERVED_FDS[$position]}"
done
touch "$IDLE_RELEASED"

while [ ! -e "$ACTIVE_RELEASE" ]; do sleep 0.05; done
LOCK_HOLDER
  status_tmp="${RECONCILE_LOCK_HOLDER_STATUS}.tmp.${BASHPID}"
  printf '%s\n' "$lock_holder_status" >"$status_tmp"
  mv "$status_tmp" "$RECONCILE_LOCK_HOLDER_STATUS"
  exit "$lock_holder_status"
) >"$RECONCILE_LOCK_HOLDER_ERROR" 2>&1 &
RECONCILE_LOCK_HOLDER_PID=$!

fail_reconcile_lock_holder() {
  local status=$1 checkpoint=$2
  [ ! -s "$RECONCILE_LOCK_HOLDER_ERROR" ] \
    || cat "$RECONCILE_LOCK_HOLDER_ERROR"
  fail "namespace pool reservation helper completed with status ${status} ${checkpoint}"
}

fail_if_reconcile_lock_holder_completed() {
  local checkpoint=$1 status
  if [ -s "$RECONCILE_LOCK_HOLDER_STATUS" ]; then
    status=$(<"$RECONCILE_LOCK_HOLDER_STATUS")
    fail_reconcile_lock_holder "$status" "$checkpoint"
  fi
}

RECONCILE_LOCK_PUBLISH_ACKNOWLEDGED=false
RECONCILE_LOCK_READY_DEADLINE=$((SECONDS + RECONCILE_CAPACITY_TIMEOUT_SECONDS + 5))
while [ "$SECONDS" -lt "$RECONCILE_LOCK_READY_DEADLINE" ]; do
  [ -s "$RECONCILE_LOCK_INFO" ] && break
  fail_if_reconcile_lock_holder_completed "before publishing pool indexes"
  if [ -e "$RECONCILE_LOCK_PUBLISH_READY" ] \
    && [ "$RECONCILE_LOCK_PUBLISH_ACKNOWLEDGED" = false ]; then
    touch "$RECONCILE_LOCK_PUBLISH_RELEASE"
    RECONCILE_LOCK_PUBLISH_ACKNOWLEDGED=true
  fi
  sleep 0.05
done
if [ ! -s "$RECONCILE_LOCK_INFO" ]; then
  fail_if_reconcile_lock_holder_completed "before publishing pool indexes"
  [ ! -s "$RECONCILE_LOCK_HOLDER_ERROR" ] \
    || cat "$RECONCILE_LOCK_HOLDER_ERROR"
  fail "timed out waiting for namespace pool reservation helper"
fi
[ "$RECONCILE_LOCK_PUBLISH_ACKNOWLEDGED" = true ] \
  || fail "namespace pool reservation helper skipped delayed publication"
mapfile -t RECONCILE_POOL_INDEXES <"$RECONCILE_LOCK_INFO"
printf -v RECONCILE_FIREWALL_POOL_HEX '%02x' "${RECONCILE_POOL_INDEXES[2]}"
printf -v RECONCILE_ACTIVE_POOL_HEX '%02x' "${RECONCILE_POOL_INDEXES[3]}"

cat >"$RECONCILE_BIN_DIR/network-command" <<'NETWORK_COMMAND'
#!/usr/bin/env bash
set -euo pipefail

COMMAND_NAME=${0##*/}

find_own_pool_hex() {
  local fd target index
  for fd in /proc/"$PPID"/fd/*; do
    target=$(readlink "$fd" 2>/dev/null || true)
    case "$target" in
      */vm0-netns-pool-*.lock)
        index=${target##*/vm0-netns-pool-}
        index=${index%.lock}
        case "$index" in
          '' | *[!0-9]*) continue ;;
        esac
        if [ "$index" -lt 64 ]; then
          printf '%02x\n' "$index"
          return 0
        fi
        ;;
    esac
  done
  return 1
}

contains_argument() {
  local expected=$1
  shift
  local argument
  for argument in "$@"; do
    [ "$argument" = "$expected" ] && return 0
  done
  return 1
}

case "$COMMAND_NAME" in
  iptables-save | ip6tables-save)
    SNAPSHOT_CAPTURE=false
    SNAPSHOT_MARKER=""
    if [ "${1:-}" = "-t" ] && [ -n "${2:-}" ]; then
      printf '1\n' >>"$OKOU_RECONCILE_COUNT_DIR/${COMMAND_NAME}.${2}"
      SNAPSHOT_MARKER="$OKOU_RECONCILE_COUNT_DIR/snapshot-${COMMAND_NAME}.${2}"
      if mkdir "$SNAPSHOT_MARKER" 2>/dev/null; then
        SNAPSHOT_CAPTURE=true
      fi
    fi
    if [ "$COMMAND_NAME" = "iptables-save" ]; then
      REAL_COMMAND=$OKOU_RECONCILE_REAL_IPTABLES_SAVE
    else
      REAL_COMMAND=$OKOU_RECONCILE_REAL_IP6TABLES_SAVE
    fi
    if "$REAL_COMMAND" "$@"; then
      STATUS=0
    else
      STATUS=$?
    fi
    if [ "$STATUS" -eq 0 ] && [ "$SNAPSHOT_CAPTURE" = true ]; then
      touch "$SNAPSHOT_MARKER/succeeded"
    fi
    if [ "$STATUS" -eq 0 ] && [ "${1:-}" = "-t" ] && [ "${2:-}" = "filter" ]; then
      OWN_POOL_HEX=$(find_own_pool_hex)
      printf '%s\n' "$OWN_POOL_HEX" >"$OKOU_RECONCILE_COUNT_DIR/own-pool"
      if [ "$COMMAND_NAME" = "iptables-save" ] \
        && [ ! -e "$OKOU_RECONCILE_COUNT_DIR/firewall-snapshot-seeded" ]; then
        touch "$OKOU_RECONCILE_COUNT_DIR/firewall-snapshot-seeded"
        printf '%s\n' \
          "-A VM0-RECONCILE-OWN -m comment --comment \"vm0-ns-${OWN_POOL_HEX}-fd\" -j ACCEPT" \
          "-A VM0-RECONCILE-IDLE -m comment --comment \"vm0-ns-${OKOU_RECONCILE_FIREWALL_POOL_HEX}-dns\" -j REJECT" \
          "-A VM0-RECONCILE-DECOY -m comment --comment \"vm0-ns-${OKOU_RECONCILE_FIREWALL_POOL_HEX}-dns-extra\" -j REJECT"
      fi
    fi
    exit "$STATUS"
    ;;
  iptables-restore | ip6tables-restore)
    RESTORE_FILE=${!#}
    if [ "$COMMAND_NAME" = "iptables-restore" ]; then
      REAL_COMMAND=$OKOU_RECONCILE_REAL_IPTABLES_RESTORE
    else
      REAL_COMMAND=$OKOU_RECONCILE_REAL_IP6TABLES_RESTORE
    fi

    if grep -F -- "vm0-ns-$(<"$OKOU_RECONCILE_COUNT_DIR/own-pool")-fd" \
      "$RESTORE_FILE" >/dev/null; then
      printf '1\n' >>"$OKOU_RECONCILE_COUNT_DIR/iptables.own-delete"
    fi
    if grep -F -- "vm0-ns-${OKOU_RECONCILE_FIREWALL_POOL_HEX}-dns" \
      "$RESTORE_FILE" >/dev/null; then
      if flock -n "/var/lock/vm0-netns-pool-${OKOU_RECONCILE_FIREWALL_POOL_INDEX}.lock" true; then
        printf '1\n' >>"$OKOU_RECONCILE_COUNT_DIR/iptables.firewall-only-unlocked"
      fi
      printf '1\n' >>"$OKOU_RECONCILE_COUNT_DIR/iptables.firewall-only-delete"
      touch "$OKOU_RECONCILE_FIREWALL_DELETE_STARTED"
      for _ in $(seq 1 1200); do
        [ -e "$OKOU_RECONCILE_FIREWALL_DELETE_RELEASE" ] && break
        sleep 0.05
      done
      [ -e "$OKOU_RECONCILE_FIREWALL_DELETE_RELEASE" ] || exit 1
    fi
    if grep -F -- "vm0-ns-${OKOU_RECONCILE_FIREWALL_POOL_HEX}-dns-extra" \
      "$RESTORE_FILE" >/dev/null; then
      printf '1\n' >>"$OKOU_RECONCILE_COUNT_DIR/iptables.decoy-delete"
    fi

    SANITIZED_RESTORE_FILE=$(mktemp "$OKOU_RECONCILE_COUNT_DIR/restore.XXXXXX")
    grep -F -v \
      -e 'VM0-RECONCILE-OWN' \
      -e 'VM0-RECONCILE-IDLE' \
      -e 'VM0-RECONCILE-DECOY' \
      "$RESTORE_FILE" >"$SANITIZED_RESTORE_FILE"
    RESTORE_ARGS=("$@")
    RESTORE_ARGS[$((${#RESTORE_ARGS[@]} - 1))]=$SANITIZED_RESTORE_FILE
    if "$REAL_COMMAND" "${RESTORE_ARGS[@]}"; then
      STATUS=0
    else
      STATUS=$?
    fi
    rm -f "$SANITIZED_RESTORE_FILE"
    exit "$STATUS"
    ;;
  iptables)
    exec "$OKOU_RECONCILE_REAL_IPTABLES" "$@"
    ;;
  ip)
    if [ "${1:-}" = "netns" ] && [ "${2:-}" = "list" ]; then
      printf '1\n' >>"$OKOU_RECONCILE_COUNT_DIR/ip.netns-list"
      if REAL_OUTPUT=$("$OKOU_RECONCILE_REAL_IP" "$@"); then
        STATUS=0
      else
        STATUS=$?
      fi
      if [ "$STATUS" -eq 0 ]; then
        OWN_POOL_HEX=$(find_own_pool_hex)
        printf '%s\n' "$OWN_POOL_HEX" >"$OKOU_RECONCILE_COUNT_DIR/own-pool"
        [ -z "$REAL_OUTPUT" ] || printf '%s\n' "$REAL_OUTPUT"
        if ! awk -v name="vm0-ns-${OWN_POOL_HEX}-fd" \
          '$1 == name { found = 1 } END { exit !found }' <<<"$REAL_OUTPUT"; then
          printf '%s\n' "vm0-ns-${OWN_POOL_HEX}-fd"
        fi
        if ! awk -v name="vm0-ns-${OKOU_RECONCILE_ACTIVE_POOL_HEX}-fc" \
          '$1 == name { found = 1 } END { exit !found }' <<<"$REAL_OUTPUT"; then
          printf '%s\n' "vm0-ns-${OKOU_RECONCILE_ACTIVE_POOL_HEX}-fc"
        fi
      fi
      exit "$STATUS"
    fi

    OWN_POOL_HEX=$(<"$OKOU_RECONCILE_COUNT_DIR/own-pool")
    if [ "${1:-}" = "link" ] && [ "${2:-}" = "del" ] \
      && [ "${3:-}" = "vm0-ve-${OWN_POOL_HEX}-fd" ]; then
      printf '1\n' >>"$OKOU_RECONCILE_COUNT_DIR/ip.own-link-delete"
      exec "$OKOU_RECONCILE_REAL_IP" "$@"
    fi
    if [ "${1:-}" = "netns" ] && [ "${2:-}" = "del" ] \
      && [ "${3:-}" = "vm0-ns-${OWN_POOL_HEX}-fd" ]; then
      printf '1\n' >>"$OKOU_RECONCILE_COUNT_DIR/ip.own-netns-delete"
      touch "$OKOU_RECONCILE_IDLE_RELEASE"
      for _ in $(seq 1 200); do
        [ -e "$OKOU_RECONCILE_IDLE_RELEASED" ] && break
        sleep 0.05
      done
      [ -e "$OKOU_RECONCILE_IDLE_RELEASED" ] || exit 1
      exec "$OKOU_RECONCILE_REAL_IP" "$@"
    fi
    if contains_argument "vm0-ns-${OKOU_RECONCILE_ACTIVE_POOL_HEX}-fc" "$@" \
      || contains_argument "vm0-ve-${OKOU_RECONCILE_ACTIVE_POOL_HEX}-fc" "$@"; then
      printf '1\n' >>"$OKOU_RECONCILE_COUNT_DIR/ip.active-delete"
      exit 0
    fi
    exec "$OKOU_RECONCILE_REAL_IP" "$@"
    ;;
esac

exit 127
NETWORK_COMMAND
chmod 755 "$RECONCILE_BIN_DIR/network-command"
for command in \
  ip \
  iptables \
  iptables-save \
  iptables-restore \
  ip6tables-save \
  ip6tables-restore; do
  ln -s network-command "$RECONCILE_BIN_DIR/$command"
done

# Start transient runner service
echo "--- Starting runner ---"
sudo "$BIN_DIR/runner" service start --name "$SVC" \
  --config "$RUNNER_DIR/runner.yaml" --local \
  --env USE_MOCK_CLAUDE=true \
  --env USE_MOCK_CODEX=true \
  --env "PATH=$RECONCILE_BIN_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  --env "OKOU_RECONCILE_COUNT_DIR=$RECONCILE_COUNT_DIR" \
  --env "OKOU_RECONCILE_REAL_IP=$REAL_IP" \
  --env "OKOU_RECONCILE_REAL_IPTABLES=$REAL_IPTABLES" \
  --env "OKOU_RECONCILE_REAL_IPTABLES_SAVE=$REAL_IPTABLES_SAVE" \
  --env "OKOU_RECONCILE_REAL_IPTABLES_RESTORE=$REAL_IPTABLES_RESTORE" \
  --env "OKOU_RECONCILE_REAL_IP6TABLES_SAVE=$REAL_IP6TABLES_SAVE" \
  --env "OKOU_RECONCILE_REAL_IP6TABLES_RESTORE=$REAL_IP6TABLES_RESTORE" \
  --env "OKOU_RECONCILE_FIREWALL_POOL_INDEX=${RECONCILE_POOL_INDEXES[2]}" \
  --env "OKOU_RECONCILE_FIREWALL_POOL_HEX=$RECONCILE_FIREWALL_POOL_HEX" \
  --env "OKOU_RECONCILE_FIREWALL_DELETE_STARTED=$RECONCILE_FIREWALL_DELETE_STARTED" \
  --env "OKOU_RECONCILE_FIREWALL_DELETE_RELEASE=$RECONCILE_FIREWALL_DELETE_RELEASE" \
  --env "OKOU_RECONCILE_ACTIVE_POOL_HEX=$RECONCILE_ACTIVE_POOL_HEX" \
  --env "OKOU_RECONCILE_IDLE_RELEASE=$RECONCILE_IDLE_RELEASE" \
  --env "OKOU_RECONCILE_IDLE_RELEASED=$RECONCILE_IDLE_RELEASED"

sudo touch "$RECONCILE_CAPACITY_RELEASE"
for _ in $(seq 1 200); do
  [ -e "$RECONCILE_CAPACITY_RELEASED" ] && break
  fail_if_reconcile_lock_holder_completed "before releasing capacity"
  sleep 0.05
done
fail_if_reconcile_lock_holder_completed "before releasing capacity"
[ -e "$RECONCILE_CAPACITY_RELEASED" ] \
  || fail "timed out releasing runner namespace pool capacity"

assert_reconcile_count() {
  local name=$1 expected=$2 path="$RECONCILE_COUNT_DIR/$1" actual=0
  if [ -f "$path" ]; then
    actual=$(wc -l <"$path")
  fi
  [ "$actual" -eq "$expected" ] \
    || fail "expected $expected reconciliation $name call(s), found $actual"
}

# Pause the runner at the cross-pool mutation boundary. This keeps later
# warm-up or namespace failure cleanup from being mistaken for another startup
# discovery pass while also proving that the target pool lock is still held.
echo "--- Waiting for startup reconciliation checkpoint ---"
for _ in $(seq 1 1200); do
  [ -e "$RECONCILE_FIREWALL_DELETE_STARTED" ] && break
  sleep 0.05
done
[ -e "$RECONCILE_FIREWALL_DELETE_STARTED" ] \
  || fail "startup reconciliation did not reach the firewall cleanup checkpoint"

echo "--- Test: startup reconciliation uses one host snapshot ---"
# Failed snapshot sources stay abandoned instead of triggering a per-namespace
# fallback that repeats whole-table reads.
assert_reconcile_count iptables-save.raw 1
assert_reconcile_count iptables-save.nat 1
assert_reconcile_count iptables-save.filter 1
assert_reconcile_count ip6tables-save.filter 1
assert_reconcile_count ip.netns-list 1
assert_reconcile_count iptables.own-delete 1
assert_reconcile_count ip.own-link-delete 1
assert_reconcile_count ip.own-netns-delete 1
assert_reconcile_count iptables.firewall-only-delete 1
assert_reconcile_count iptables.firewall-only-unlocked 0
assert_reconcile_count iptables.decoy-delete 0
assert_reconcile_count ip.active-delete 0
sudo touch "$RECONCILE_FIREWALL_DELETE_RELEASE"
echo "PASS: startup reconciled one snapshot without modifying the active pool"

# Submit a long-running job in background
echo "--- Submitting long-running job ---"
exec {SUBMIT_OUTPUT_FD}>"$SUBMIT_OUTPUT"
sudo "$BIN_DIR/runner" local submit \
  --group "$GROUP" --prompt 'sleep 60 && echo done' \
  >&"$SUBMIT_OUTPUT_FD" 2>&1 &
SUBMIT_PID=$!
exec {SUBMIT_OUTPUT_FD}>&-

# Resolve this submission from its claim instead of selecting the first active
# run. A failed prior attempt must never redirect cancellation to stale work.
echo "--- Waiting for sandbox ---"
RUN_ID=""
SANDBOX_ID=""
SANDBOX_READY=false
for _ in $(seq 1 60); do
  mapfile -t CLAIM_FILES < <(
    sudo find "$GROUP_DIR/claims" -maxdepth 1 -type f -name '*.claim' \
      -printf '%f\n' 2>/dev/null | sort
  )
  [ "${#CLAIM_FILES[@]}" -le 1 ] \
    || fail "expected one claimed job, found ${#CLAIM_FILES[@]}"
  if [ "${#CLAIM_FILES[@]}" -eq 1 ]; then
    RUN_ID=${CLAIM_FILES[0]%.claim}
    SANDBOX_ID=$(sudo jq -r --arg run_id "$RUN_ID" \
      '.active_runs[]? | select(.run_id == $run_id) | .sandbox_id' \
      "$RUNNER_DIR/status.json" 2>/dev/null)
    if [ -n "$SANDBOX_ID" ] \
      && [ -S "/run/vm0/sock/$SANDBOX_ID/control.sock" ]; then
      SANDBOX_READY=true
      break
    fi
  fi
  SANDBOX_ID=""
  sleep 1
done
[ "$SANDBOX_READY" = true ] || fail "sandbox not found after 60s"
echo "Found run $RUN_ID (sandbox $SANDBOX_ID)"

# Test 1: cancel the job via runner local cancel
echo "--- Test: runner local cancel ---"
sudo "$BIN_DIR/runner" local cancel --run "$RUN_ID" --group "$GROUP" || fail "cancel command failed"
echo "PASS: cancel command succeeded"

# Test 2: submit should exit quickly, well before the prompt completes.
echo "--- Test: waiting for submit to finish ---"
SECONDS=0
if wait "$SUBMIT_PID"; then
  SUBMIT_EXIT=0
else
  SUBMIT_EXIT=$?
fi
SUBMIT_PID=""
ELAPSED=$SECONDS
cat "$SUBMIT_OUTPUT"
echo "Submit exited with code $SUBMIT_EXIT in ${ELAPSED}s"
SUBMIT_JSON=$(awk '/^\{/{line=$0} END{print line}' "$SUBMIT_OUTPUT")
SUBMIT_RUN_ID=$(jq -r '.run_id // empty' <<<"$SUBMIT_JSON")
[ "$SUBMIT_RUN_ID" = "$RUN_ID" ] \
  || fail "cancelled run $RUN_ID but submit returned ${SUBMIT_RUN_ID:-missing}"
# Cancel should kill the job within 30s, not after the 60s prompt.
[ "$ELAPSED" -lt 30 ] || fail "submit took ${ELAPSED}s to exit — cancel likely did not work"
# Cancelled job returns non-zero exit code
[ "$SUBMIT_EXIT" -ne 0 ] || fail "expected non-zero exit from cancelled job, got 0"
echo "PASS: submit exited with non-zero after cancel (${ELAPSED}s)"

# Stop transient service
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
rm -f "$SUBMIT_OUTPUT"
touch "$RECONCILE_ACTIVE_RELEASE"
if wait "$RECONCILE_LOCK_HOLDER_PID"; then
  RECONCILE_LOCK_HOLDER_EXIT=0
else
  RECONCILE_LOCK_HOLDER_EXIT=$?
fi
RECONCILE_LOCK_HOLDER_PID=""
if [ "$RECONCILE_LOCK_HOLDER_EXIT" -ne 0 ]; then
  fail_reconcile_lock_holder \
    "$RECONCILE_LOCK_HOLDER_EXIT" \
    "after releasing active locks"
fi
sudo rm -rf "$RECONCILE_TEST_DIR"
trap - EXIT

echo "=== Cancel test passed ==="
