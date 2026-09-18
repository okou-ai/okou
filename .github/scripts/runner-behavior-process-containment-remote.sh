#!/usr/bin/env bash
set -euo pipefail

BIN_DIR=$1; JOB_REF=$2; AGENT_READY_BENCHMARK_SAMPLES=$3
SVC="${JOB_REF}-process-containment"
GROUP="vm0/process-containment-${JOB_REF}"
RUNNER_DIR="/var/lib/vm0-runner/runners/${SVC}"
GROUP_DIR="/var/lib/vm0-runner/groups/vm0/process-containment-${JOB_REF}"
AGENT_READY_BENCHMARK_WORKER="${RUNNER_DIR}/agent-ready-benchmark.sh"
UNIT="vm0-runner-${SVC}.service"
SESSION_ID="e2e-process-containment-session"
CHAT_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
PRESSURE_SUBMIT_PID=""
PRESSURE_SUBMIT_OUTPUT=""

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
  if [ -n "$PRESSURE_SUBMIT_PID" ]; then
    kill "$PRESSURE_SUBMIT_PID" 2>/dev/null || true
    wait "$PRESSURE_SUBMIT_PID" 2>/dev/null || true
  fi
  if [ -n "$PRESSURE_SUBMIT_OUTPUT" ]; then
    rm -f "$PRESSURE_SUBMIT_OUTPUT"
  fi
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force || true
  wait_for_unit_inactive
  sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
}
trap cleanup EXIT

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

LEAK_PROMPT=$(cat <<'PROMPT'
set -eu
marker=/tmp/vm0-process-containment
rm -rf "$marker"
mkdir -p "$marker"
touch "$marker/sandbox-reuse-marker"

# Observe the policy installed by guest-init in the restored snapshot.
awk '$2 == "/sys/fs/cgroup" && $3 == "cgroup2" && $4 ~ /(^|,)favordynmods(,|$)/ { found = 1 } END { exit !found }' /proc/mounts \
  || { echo "guest cgroup2 mount is missing favordynmods" >&2; exit 1; }

expected_path="/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games:$HOME/go/bin:$HOME/.cargo/bin:$HOME/.local/bin:$HOME/bin"
if [ "$PATH" != "$expected_path" ]; then
  echo "Guest Agent CLI child PATH changed: expected=$expected_path actual=$PATH" >&2
  exit 1
fi
# Install tools after the agent has started and resolve them by name, without
# exporting PATH or sourcing a user profile.
(
  user_tool=
  trap 'test -z "$user_tool" || rm -f "$user_tool"' EXIT
  for user_bin in "$HOME/.local/bin" "$HOME/bin"; do
    mkdir -p "$user_bin"
    user_tool=$(mktemp "$user_bin/okou-user-path-smoke-XXXXXX")
    printf '#!/bin/sh\nprintf user-tool-found\n' > "$user_tool"
    chmod +x "$user_tool"
    user_tool_name=${user_tool##*/}
    test "$("$user_tool_name")" = user-tool-found
    rm "$user_tool"
    user_tool=
  done
)
assert_env_value() {
  key=$1
  expected=$2
  actual=$(printenv "$key" || true)
  if [ "$actual" != "$expected" ]; then
    echo "Guest Agent CLI child $key changed: expected=$expected actual=$actual" >&2
    exit 1
  fi
}
assert_env_value SHELL /bin/bash
assert_env_value LANG C.UTF-8
assert_env_value NPM_CONFIG_UPDATE_NOTIFIER false
assert_env_value NODE_EXTRA_CA_CERTS /usr/local/share/ca-certificates/vm0-proxy-ca.crt
assert_env_value SSL_CERT_FILE /etc/ssl/certs/ca-certificates.crt
assert_env_value REQUESTS_CA_BUNDLE /etc/ssl/certs/ca-certificates.crt
assert_env_value CARGO_HTTP_CAINFO /etc/ssl/certs/ca-certificates.crt
assert_env_value RUSTUP_HOME /usr/local/rustup
# Exercise the preinstalled toolchain through the actual agent tool environment,
# outside any project that could select a different toolchain.
mkdir "$marker/rust-toolchain-smoke"
(
  cd "$marker/rust-toolchain-smoke"
  rustc --version
  cargo --version
  cargo fmt --version
)
if sudo find /run/vm0-exec -mindepth 1 -maxdepth 2 -print -quit | grep -q .; then
  echo "Guest Agent startup left a generic environment script" >&2
  exit 1
fi

base=/sys/fs/cgroup/vm0-exec
relative=$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup)
case "$relative" in
  /vm0-exec/exec-*/workload/tools/tool-*) ;;
  *) echo "Bash tool is outside its tool cgroup: $relative" >&2; exit 1 ;;
esac
bash_executable=$(readlink -f /bin/bash)
tool_executor=$(readlink -f /usr/local/bin/guest-tool-exec)
current_executable=$(readlink -f /proc/$$/exe)
test "$bash_executable" != "$tool_executor" \
  || { echo "distribution Bash was replaced by the tool executor" >&2; exit 1; }
test "$current_executable" = "$bash_executable" \
  || { echo "tool executor did not hand off to distribution Bash" >&2; exit 1; }
tools=${relative%/*}
workload=${tools%/tools}
operation=${workload%/workload}
parent="/sys/fs/cgroup$operation"
test -d "$parent/control"
test -d "$parent/workload"
test -d "$parent/workload/runtime"
test -d "$parent/workload/tools"
for controller in cpu memory pids; do
  grep -qw "$controller" "$base/cgroup.subtree_control"
  grep -qw "$controller" "$parent/cgroup.subtree_control"
  grep -qw "$controller" "$parent/workload/cgroup.subtree_control"
done
expected_control_memory_min=$((128 * 1024 * 1024))
expected_runtime_memory_min=$((384 * 1024 * 1024))
expected_agent_memory_min=$((expected_control_memory_min + expected_runtime_memory_min))
expected_workload_memory_reserve=$((128 * 1024 * 1024))
guest_memory_bytes=$(( $(getconf _PHYS_PAGES) * $(getconf PAGE_SIZE) ))
expected_workload_memory_max=$((guest_memory_bytes - expected_workload_memory_reserve))
test "$(cat "$base/memory.min")" = "$expected_agent_memory_min"
test "$(cat "$parent/memory.min")" = "$expected_agent_memory_min"
test "$(cat "$parent/control/memory.min")" = "$expected_control_memory_min"
test "$(cat "$parent/workload/memory.min")" = "$expected_runtime_memory_min"
test "$(cat "$parent/workload/runtime/memory.min")" = "$expected_runtime_memory_min"
grep -Eq '^[0-9]+ [0-9]+$' "$parent/workload/cpu.max"
test "$(cat "$parent/workload/memory.high")" = max
test "$(cat "$parent/workload/memory.max")" = "$expected_workload_memory_max"
test "$(cat "$parent/workload/memory.oom.group")" = 0
test "$(cat "$parent/workload/pids.max")" = max
test "$(cat "$parent/workload/tools/memory.max")" = max
test "$(cat "$parent/workload/tools/memory.min")" = 0
test "$(cat "$parent/workload/tools/memory.oom.group")" = 0
grep -qw memory "$parent/workload/tools/cgroup.subtree_control"
test "$(cat "/sys/fs/cgroup$relative/memory.oom.group")" = 1
test "$(cat "/sys/fs/cgroup$relative/memory.min")" = 0
test "$(cat /proc/self/oom_score_adj)" = 1000
bash -c 'test "$(cat /proc/self/oom_score_adj)" = 1000'
for runtime_pid in $(cat "$parent/workload/runtime/cgroup.procs"); do
  test "$(cat "/proc/$runtime_pid/oom_score_adj")" = 0
done

# A private mount namespace makes only this launcher's real procfs score file
# read-only. Enter as root for fixture setup, then restore the runtime UID/GID
# before the production launcher authenticates with the placement broker.
test_uid=$(id -u)
test_gid=$(id -g)
for setup_mode in hook shell; do
if sudo -n --preserve-env=OKOU_TOOL_CGROUP_PROCS_ENDPOINT \
  unshare --mount bash -s -- "$parent/workload/runtime/cgroup.procs" \
  "$test_uid" "$test_gid" "$setup_mode" \
  >"$marker/oom-priority-$setup_mode.stdout" \
  2>"$marker/oom-priority-$setup_mode.stderr" <<'SETUP'
set -eu
mount --make-rprivate /
score_file=/proc/$$/oom_score_adj
mount --bind "$score_file" "$score_file"
mount -o remount,bind,ro "$score_file"
printf 0 > "$1"
if [ "$4" = hook ]; then
  exec setpriv --reuid="$2" --regid="$3" --clear-groups \
    /usr/local/bin/guest-tool-exec hook <<'HOOK'
{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"true"}}
HOOK
fi
exec setpriv --reuid="$2" --regid="$3" --clear-groups \
  /usr/local/bin/guest-tool-exec -c 'touch /tmp/vm0-process-containment/unsafe-command-ran'
SETUP
then
  test "$setup_mode" = hook
else
  test "$?" = 125
  test "$setup_mode" = shell
fi
done
test ! -e "$marker/unsafe-command-ran"
grep -Fq '"permissionDecision":"allow"' "$marker/oom-priority-hook.stdout"
grep -Fq 'OOM priority setup failed:' "$marker/oom-priority-shell.stderr"

test -z "${OKOU_WORKLOAD_CGROUP_PROCS_ENDPOINT+x}"
test "${OKOU_TOOL_CGROUP_PROCS_ENDPOINT+x}" = x
test -n "$OKOU_TOOL_CGROUP_PROCS_ENDPOINT"
control_member_count=$(wc -l < "$parent/control/cgroup.procs")
if [ "$control_member_count" -ne 1 ]; then
  echo "control cgroup must contain only Guest Agent; members=$(tr '\n' ' ' < "$parent/control/cgroup.procs")" >&2
  exit 1
fi
control_pid=$(cat "$parent/control/cgroup.procs")
if [ "$(cat "/proc/$control_pid/comm")" != "guest-agent" ]; then
  echo "control cgroup member is not Guest Agent: pid=$control_pid comm=$(cat "/proc/$control_pid/comm")" >&2
  exit 1
fi
if ls "/proc/$control_pid/fd" >/dev/null 2>&1; then
  echo "workload can inspect Guest Agent descriptors" >&2
  exit 1
fi
if printf 0 > "$parent/control/cgroup.procs" 2>/dev/null; then
  echo "workload can move itself into the control cgroup" >&2
  exit 1
fi

setsid python3 -c 'import os, pathlib, signal, time; p=pathlib.Path("/tmp/vm0-process-containment/user.identity"); fields=pathlib.Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split(); signal.signal(signal.SIGTERM, signal.SIG_IGN); p.write_text(f"{os.getpid()} {fields[19]}\n"); time.sleep(300)' </dev/null >"$marker/user.launch.log" 2>&1 &
user_launcher_pid=$!
setsid sudo -n python3 -c 'import os, pathlib, time; p=pathlib.Path("/tmp/vm0-process-containment/root.identity"); fields=pathlib.Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split(); p.write_text(f"{os.getpid()} {fields[19]}\n"); time.sleep(300)' </dev/null >"$marker/root.launch.log" 2>&1 &
root_launcher_pid=$!

fixture_fail() {
  local name=$1
  local exit_code=$2
  shift 2
  local log="$marker/$name.launch.log"
  echo "$name descendant setup failed: $*" >&2
  if [ -s "$log" ]; then
    echo "--- $name launcher log ---" >&2
    cat "$log" >&2
  fi
  exit "$exit_code"
}

launcher_is_alive() {
  local pid=$1
  local stat state
  if ! IFS= read -r stat 2>/dev/null < "/proc/$pid/stat"; then
    return 1
  fi
  stat=${stat##*) }
  state=${stat%% *}
  case "$state" in
    Z|X|x) return 1 ;;
    *) return 0 ;;
  esac
}

verify_live_identity() {
  local name=$1
  local exit_code=$2
  local identity="$marker/$name.identity"
  local pid start_time current_identity current_state current_start

  if ! read -r pid start_time < "$identity"; then
    fixture_fail "$name" "$exit_code" "invalid identity file"
  fi
  if ! current_identity=$(awk '{sub(/^.*\) /, ""); print $1, $20}' "/proc/$pid/stat" 2>/dev/null); then
    fixture_fail "$name" "$exit_code" "process $pid exited"
  fi
  current_state=${current_identity%% *}
  current_start=${current_identity#* }
  case "$current_state" in
    Z|X|x) fixture_fail "$name" "$exit_code" "process $pid is in state $current_state" ;;
  esac
  [ "$current_start" = "$start_time" ] \
    || fixture_fail "$name" "$exit_code" "process $pid identity changed"
}

for _ in $(seq 1 200); do
  [ -s "$marker/user.identity" ] && [ -s "$marker/root.identity" ] && break
  if [ ! -s "$marker/user.identity" ] \
    && ! launcher_is_alive "$user_launcher_pid"; then
    if wait "$user_launcher_pid"; then
      user_status=0
    else
      user_status=$?
    fi
    fixture_fail user 10 "launcher exited before publishing identity (status=$user_status)"
  fi
  if [ ! -s "$marker/root.identity" ] \
    && ! launcher_is_alive "$root_launcher_pid"; then
    if wait "$root_launcher_pid"; then
      root_status=0
    else
      root_status=$?
    fi
    fixture_fail root 11 "launcher exited before publishing identity (status=$root_status)"
  fi
  sleep 0.05
done
[ -s "$marker/user.identity" ] \
  || fixture_fail user 12 "readiness deadline exceeded"
[ -s "$marker/root.identity" ] \
  || fixture_fail root 13 "readiness deadline exceeded"
verify_live_identity user 14
verify_live_identity root 15

# Persist adversarial login profiles for the next reuse turn. Production
# Guest Agent bootstrap executes the fixed binary directly and uses SCM_RIGHTS,
# so no profile can run before the trusted binary or retain a placement
# capability.
cat > "$HOME/.profile" <<'PROFILE'
touch /tmp/vm0-process-containment/profile-executed
for descriptor in /proc/self/fd/*; do
  target=$(readlink "$descriptor" 2>/dev/null || true)
  case "$target" in
    */workload/runtime/cgroup.procs)
      printf '%s\n' "$target" > /tmp/vm0-process-containment/profile-capability
      ;;
  esac
done
(sleep 300) &
PROFILE
cp "$HOME/.profile" "$HOME/.bash_profile"
cat > "$HOME/.vm0-bootstrap-env" <<'BASH_ENV'
touch /tmp/vm0-process-containment/pam-environment-executed
BASH_ENV
cat > "$HOME/.pam_environment" <<'PAM_ENV'
BASH_ENV DEFAULT=/home/user/.vm0-bootstrap-env
PAM_ENV
echo containment-turn-1
PROMPT
)

echo "--- Turn 1: leave detached user/root descendants ---"
if TURN1_RESULT=$(sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$CHAT_THREAD_ID" \
  --session-id "$SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt "$LEAK_PROMPT"); then
  printf '%s\n' "$TURN1_RESULT"
else
  printf '%s\n' "$TURN1_RESULT"
  TURN1_EXIT_CODE=$(jq -r '.exit_code // empty' <<<"$TURN1_RESULT" 2>/dev/null) || true
  case "$TURN1_EXIT_CODE" in
    10) fail "Turn 1 user launcher exited before readiness" ;;
    11) fail "Turn 1 root launcher exited before readiness" ;;
    12) fail "Turn 1 user descendant readiness timed out" ;;
    13) fail "Turn 1 root descendant readiness timed out" ;;
    14) fail "Turn 1 user descendant published an invalid process identity" ;;
    15) fail "Turn 1 root descendant published an invalid process identity" ;;
    *) fail "Turn 1 failed" ;;
  esac
fi

VERIFY_PROMPT=$(cat <<'PROMPT'
set -eu
marker=/tmp/vm0-process-containment
base=/sys/fs/cgroup/vm0-exec
test -f "$marker/sandbox-reuse-marker"
awk '$2 == "/sys/fs/cgroup" && $3 == "cgroup2" && $4 ~ /(^|,)favordynmods(,|$)/ { found = 1 } END { exit !found }' /proc/mounts \
  || { echo "reused guest cgroup2 mount is missing favordynmods" >&2; exit 1; }
if [ -e "$marker/profile-executed" ]; then
  echo "sandbox login profile executed before Guest Agent" >&2
  exit 1
fi
if [ -e "$marker/profile-capability" ]; then
  echo "sandbox login profile observed workload placement capability" >&2
  exit 1
fi
if [ -e "$marker/pam-environment-executed" ]; then
  echo "sandbox PAM environment executed code before Guest Agent" >&2
  exit 1
fi
rm -f "$HOME/.profile" "$HOME/.bash_profile" \
  "$HOME/.pam_environment" "$HOME/.vm0-bootstrap-env"

for identity in "$marker/user.identity" "$marker/root.identity"; do
  read -r pid start_time < "$identity"
  if current_identity=$(awk '{sub(/^.*\) /, ""); print $1, $20}' "/proc/$pid/stat" 2>/dev/null); then
    current_state=${current_identity%% *}
    current_start=${current_identity#* }
    case "$current_state" in
      Z|X|x) ;;
      *)
        [ "$current_start" != "$start_time" ] || {
          echo "recorded descendant is still running: $identity pid=$pid" >&2
          exit 1
        }
        ;;
    esac
  fi
done

relative=$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup)
case "$relative" in
  /vm0-exec/exec-*/workload/tools/tool-*) ;;
  *) echo "unexpected current cgroup: $relative" >&2; exit 1 ;;
esac
tools=${relative%/*}
workload=${tools%/tools}
operation=${workload%/workload}
own_group=${operation##*/}
test -n "$own_group"
test -d "$base/$own_group"
test -d "$base/$own_group/control"
test -d "$base/$own_group/workload"
test -d "$base/$own_group/workload/runtime"
test -d "$base/$own_group/workload/tools"
test -z "$(find "$base" -mindepth 1 -maxdepth 1 -type d ! -name "$own_group" -print -quit)"
grep -q '^populated 1$' "$base/cgroup.events"
for controller in cpu memory pids; do
  grep -qw "$controller" "$base/cgroup.subtree_control"
  grep -qw "$controller" "$base/$own_group/cgroup.subtree_control"
  grep -qw "$controller" "$base/$own_group/workload/cgroup.subtree_control"
done
echo containment-turn-2
PROMPT
)

echo "--- Turn 2: prove descendants are gone and only this turn is owned ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$CHAT_THREAD_ID" \
  --session-id "$SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt "$VERIFY_PROMPT" \
  || fail "Turn 2 failed; sandbox was not safely reused"

echo "--- Turn 3: prove healthy Turn 2 cleanup was also reusable ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$CHAT_THREAD_ID" \
  --session-id "$SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'test -f /tmp/vm0-process-containment/sandbox-reuse-marker' \
  || fail "Turn 3 failed; healthy cleanup did not re-enter reuse"

echo "--- Pressure: sustain CPU saturation with live process control ---"
# Continue the prepared conversation so the pressure turn must reuse the sandbox
# whose containment state and cleanup were verified above. Keep the provider
# session independent so active input starts with a fresh stream.
PRESSURE_CHAT_THREAD_ID="$CHAT_THREAD_ID"
PRESSURE_SESSION_ID="e2e-process-containment-pressure"
PRESSURE_SUBMIT_OUTPUT=$(mktemp)
# The mock's readiness result is gated on the first forwarded follow-up, so
# startup scheduling cannot close active input before the queue is observed.
# The final input is sent explicitly after both sideband execs finish so the
# active turn owns the sandbox until their results are observed.
exec {PRESSURE_SUBMIT_FD}>"$PRESSURE_SUBMIT_OUTPUT"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --timeout 55 \
  --chat-thread-id "$PRESSURE_CHAT_THREAD_ID" \
  --session-id "$PRESSURE_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt '@active-input-smoke-ready:5' \
  --active-input 'after=1ms,text=cpu-pressure-ready' \
  --active-input 'after=2s,text=cpu-pressure-one' \
  --active-input 'after=4s,text=cpu-pressure-two' \
  --active-input 'after=6s,text=cpu-pressure-three' \
  >&"$PRESSURE_SUBMIT_FD" 2>&1 &
PRESSURE_SUBMIT_PID=$!
exec {PRESSURE_SUBMIT_FD}>&-

PRESSURE_RUN_ID=""
PRESSURE_SANDBOX_ID=""
for _ in $(seq 1 60); do
  if ! kill -0 "$PRESSURE_SUBMIT_PID" 2>/dev/null; then
    wait "$PRESSURE_SUBMIT_PID" 2>/dev/null || true
    PRESSURE_SUBMIT_PID=""
    cat "$PRESSURE_SUBMIT_OUTPUT"
    fail "CPU-pressure submit exited before its sandbox became ready"
  fi
  mapfile -t CLAIM_FILES < <(
    sudo find "$GROUP_DIR/claims" -maxdepth 1 -type f -name '*.claim' \
      -printf '%f\n' 2>/dev/null | sort
  )
  [ "${#CLAIM_FILES[@]}" -le 1 ] \
    || fail "expected one CPU-pressure claim, found ${#CLAIM_FILES[@]}"
  if [ "${#CLAIM_FILES[@]}" -eq 1 ]; then
    PRESSURE_RUN_ID=${CLAIM_FILES[0]%.claim}
    PRESSURE_SANDBOX_ID=$(sudo jq -r --arg run_id "$PRESSURE_RUN_ID" \
      '.active_runs[]? | select(.run_id == $run_id) | .sandbox_id' \
      "$RUNNER_DIR/status.json" 2>/dev/null)
    if [ -n "$PRESSURE_SANDBOX_ID" ] \
      && [ -S "/run/vm0/sock/$PRESSURE_SANDBOX_ID/control.sock" ]; then
      break
    fi
  fi
  PRESSURE_SANDBOX_ID=""
  sleep 1
done
[ -n "$PRESSURE_SANDBOX_ID" ] \
  || fail "CPU-pressure sandbox did not become ready"

CPU_PRESSURE_SECONDS=6
CPU_PRESSURE_COMMAND=$(cat <<'SCRIPT'
set -eu
duration=$1
relative=$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup)
case "$relative" in
  /vm0-exec/exec-*/workload) ;;
  *) echo "CPU pressure is outside workload cgroup: $relative" >&2; exit 1 ;;
esac
workload="/sys/fs/cgroup$relative"
before=$(awk '$1 == "nr_throttled" { print $2 }' "$workload/cpu.stat")
worker_count=$(( $(getconf _NPROCESSORS_ONLN) * 4 ))
worker_pids=""
cleanup_workers() {
  if [ -n "$worker_pids" ]; then
    kill $worker_pids 2>/dev/null || true
    wait $worker_pids 2>/dev/null || true
  fi
}
trap cleanup_workers EXIT INT TERM
worker=0
while [ "$worker" -lt "$worker_count" ]; do
  yes >/dev/null &
  worker_pids="$worker_pids $!"
  worker=$((worker + 1))
done
sleep "$duration"
after=$(awk '$1 == "nr_throttled" { print $2 }' "$workload/cpu.stat")
[ "$after" -gt "$before" ] \
  || { echo "CPU quota did not throttle the workload" >&2; exit 1; }
echo "cpu-pressure-complete throttled_periods=$((after - before))"
SCRIPT
)
SECONDS=0
CPU_PRESSURE_RESULT=$(sudo "$BIN_DIR/runner" exec \
  --timeout 30 \
  --sandbox "$PRESSURE_SANDBOX_ID" \
  -- sh -c "$CPU_PRESSURE_COMMAND" sh "$CPU_PRESSURE_SECONDS") \
  || fail "concurrent ordinary-exec CPU pressure failed"
CPU_PRESSURE_ELAPSED=$SECONDS
printf '%s\n' "$CPU_PRESSURE_RESULT"
[ "$CPU_PRESSURE_ELAPSED" -ge "$CPU_PRESSURE_SECONDS" ] \
  || fail "CPU pressure ended early after ${CPU_PRESSURE_ELAPSED}s"
grep -E -q '^cpu-pressure-complete throttled_periods=[1-9][0-9]*$' \
  <<<"$CPU_PRESSURE_RESULT" \
  || fail "CPU pressure did not report throttling"

echo "--- Evidence: return mixed-identity pids.max cleanup through exec result ---"
PID_EVIDENCE_COMMAND=$(cat <<'PYTHON'
import errno
import os
import pathlib
import signal

relative = next(
    line.removeprefix("0::").strip()
    for line in pathlib.Path("/proc/self/cgroup").read_text().splitlines()
    if line.startswith("0::")
)
if not relative.startswith("/vm0-exec/exec-") or not relative.endswith("/workload"):
    raise RuntimeError(f"PID evidence is outside workload cgroup: {relative}")
workload = pathlib.Path(f"/sys/fs/cgroup{relative}")
(workload / "pids.max").write_text("64")

ready_read, ready_write = os.pipe()
children = []
while True:
    try:
        pid = os.fork()
    except OSError as error:
        if error.errno != errno.EAGAIN:
            raise
        break
    if pid == 0:
        os.close(ready_read)
        os.setsid()
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        if len(children) % 2 == 0:
            os.setgroups([])
            os.setgid(1000)
            os.setuid(1000)
        null = os.open("/dev/null", os.O_RDWR)
        for descriptor in (0, 1, 2):
            os.dup2(null, descriptor)
        if null > 2:
            os.close(null)
        os.write(ready_write, b"1")
        os.close(ready_write)
        while True:
            signal.pause()
    children.append(pid)

os.close(ready_write)
ready = b""
while len(ready) < len(children):
    chunk = os.read(ready_read, len(children) - len(ready))
    if not chunk:
        raise RuntimeError("PID-pressure readiness pipe closed early")
    ready += chunk
os.close(ready_read)
events = dict(
    line.split()
    for line in (workload / "pids.events").read_text().splitlines()
)
if int(events.get("max", "0")) == 0:
    raise RuntimeError("pids.max did not reject a workload fork")
print(
    "pid-evidence-ready "
    f"children={len(children)} "
    f"user_children={(len(children) + 1) // 2} "
    f"root_children={len(children) // 2} "
    f"max={events['max']}",
    flush=True,
)
PYTHON
)
if ! PID_EVIDENCE_RESULT=$(sudo "$BIN_DIR/runner" exec \
  --timeout 15 \
  --sandbox "$PRESSURE_SANDBOX_ID" \
  --sudo \
  --show-diagnostic \
  -- python3 -c "$PID_EVIDENCE_COMMAND" 2>&1); then
  printf '%s\n' "$PID_EVIDENCE_RESULT"
  fail "PID-pressure cleanup behavior failed before result evidence"
fi
printf '%s\n' "$PID_EVIDENCE_RESULT"
PID_EVIDENCE_CHILDREN=$(sed -n \
  's/^pid-evidence-ready children=\([0-9][0-9]*\) user_children=[1-9][0-9]* root_children=[1-9][0-9]* max=[1-9][0-9]*$/\1/p' \
  <<<"$PID_EVIDENCE_RESULT")
[ -n "$PID_EVIDENCE_CHILDREN" ] \
  || fail "PID-pressure evidence did not reach the configured pids.max boundary"
[ "$PID_EVIDENCE_CHILDREN" -ge 50 ] \
  || fail "PID-pressure evidence created only ${PID_EVIDENCE_CHILDREN} children"
PID_EVIDENCE_USER_CHILDREN=$(sed -n \
  's/^pid-evidence-ready children=[0-9][0-9]* user_children=\([1-9][0-9]*\) root_children=[1-9][0-9]* max=[1-9][0-9]*$/\1/p' \
  <<<"$PID_EVIDENCE_RESULT")
PID_EVIDENCE_ROOT_CHILDREN=$(sed -n \
  's/^pid-evidence-ready children=[0-9][0-9]* user_children=[1-9][0-9]* root_children=\([1-9][0-9]*\) max=[1-9][0-9]*$/\1/p' \
  <<<"$PID_EVIDENCE_RESULT")
[ -n "$PID_EVIDENCE_USER_CHILDREN" ] \
  || fail "PID-pressure evidence did not create user-owned descendants"
[ -n "$PID_EVIDENCE_ROOT_CHILDREN" ] \
  || fail "PID-pressure evidence did not create root-owned descendants"
PID_CLEANUP_LINE=$(printf '%s\n' "$PID_EVIDENCE_RESULT" \
  | grep -F 'exec process containment cleaned' \
  | grep -F 'descendants_observed=true' \
  | grep -F 'cgroup_kill_used=true' \
  | head -1) \
  || fail "PID-pressure cleanup behavior passed, but its successful exec result produced no populated cgroup.kill cleanup evidence"
PID_INITIAL_MEMBERS=$(sed -n \
  's/.*initial_members=\([0-9][0-9]*\).*/\1/p' \
  <<<"$PID_CLEANUP_LINE")
[ -n "$PID_INITIAL_MEMBERS" ] \
  || fail "PID-pressure cleanup result evidence omitted its initial member count"
[ "$PID_INITIAL_MEMBERS" -ge 50 ] \
  || fail "PID-pressure cleanup result evidence observed only ${PID_INITIAL_MEMBERS} members"
PID_CLEANUP_MS=$(sed -n 's/.*cleanup_ms=\([0-9][0-9]*\).*/\1/p' \
  <<<"$PID_CLEANUP_LINE")
[ -n "$PID_CLEANUP_MS" ] \
  || fail "PID-pressure cleanup result evidence omitted cleanup latency"
[ "$PID_CLEANUP_MS" -le 5000 ] \
  || fail "PID-pressure cleanup exceeded 5s: ${PID_CLEANUP_MS}ms"
LEAK_CLEANUP_MS=$PID_CLEANUP_MS
[ "$LEAK_CLEANUP_MS" -le 2000 ] \
  || fail "mixed-identity descendant cleanup exceeded bounded lifecycle: ${LEAK_CLEANUP_MS}ms"

sudo "$BIN_DIR/runner" local input --group "$GROUP" \
  --run "$PRESSURE_RUN_ID" \
  --sequence 5 \
  --text pressure-finish \
  || fail "failed to release CPU-pressure submit after sideband execs"

if wait "$PRESSURE_SUBMIT_PID"; then
  PRESSURE_SUBMIT_STATUS=0
else
  PRESSURE_SUBMIT_STATUS=$?
fi
PRESSURE_SUBMIT_PID=""
cat "$PRESSURE_SUBMIT_OUTPUT"
[ "$PRESSURE_SUBMIT_STATUS" -eq 0 ] \
  || fail "process control did not remain live during CPU pressure"
PRESSURE_SUBMIT_JSON=$(awk '/^\{/{line=$0} END{print line}' "$PRESSURE_SUBMIT_OUTPUT")
[ -n "$PRESSURE_SUBMIT_JSON" ] \
  || fail "CPU-pressure submit did not return a JSON result"
SUBMITTED_PRESSURE_RUN_ID=$(jq -r '.run_id // empty' <<<"$PRESSURE_SUBMIT_JSON")
[ "$SUBMITTED_PRESSURE_RUN_ID" = "$PRESSURE_RUN_ID" ] \
  || fail "CPU-pressure result run ID did not match its claim"
PRESSURE_STREAM_LOG="/var/lib/vm0-runner/logs/system-stream-${PRESSURE_RUN_ID}.log"
sudo grep -F -q \
  'RESULT=cpu-pressure-ready+cpu-pressure-one+cpu-pressure-two+cpu-pressure-three+pressure-finish' \
  "$PRESSURE_STREAM_LOG" \
  || fail "CPU-pressure active inputs were not all consumed in order"
rm -f "$PRESSURE_SUBMIT_OUTPUT"
PRESSURE_SUBMIT_OUTPUT=""

echo "--- Pressure: group-kill only the high-memory Bash tool ---"
# The mock CLI launches two Bash children directly from the managed runtime.
# The launcher places them in distinct tool cgroups before either shell runs.
# One tool drives the existing workload limit to OOM while the other remains alive.
# Use a fresh sandbox so the tool-isolation assertion has an independent
# lifecycle after the preceding CPU-pressure scenario.
MEMORY_CHAT_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
MEMORY_SESSION_ID="e2e-process-containment-memory"
SECONDS=0
if ! MEMORY_RESULT=$(sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --timeout 30 \
  --chat-thread-id "$MEMORY_CHAT_THREAD_ID" \
  --session-id "$MEMORY_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt '@parallel-shell-tool-oom' \
  --active-input 'after=1s,text=memory-pressure-control'); then
  printf '%s\n' "$MEMORY_RESULT"
  fail "memory-pressure submit failed before tool OOM isolation completed"
fi
MEMORY_ELAPSED=$SECONDS
printf '%s\n' "$MEMORY_RESULT"
[ "$MEMORY_ELAPSED" -lt 20 ] \
  || fail "memory-pressure recovery was not bounded: ${MEMORY_ELAPSED}s"
MEMORY_RESULT_JSON=$(awk '/^\{/{line=$0} END{print line}' <<<"$MEMORY_RESULT")
MEMORY_RUN_ID=$(jq -r '.run_id // empty' <<<"$MEMORY_RESULT_JSON")
[ -n "$MEMORY_RUN_ID" ] || fail "memory-pressure result omitted run ID"
MEMORY_STREAM_LOG="/var/lib/vm0-runner/logs/system-stream-${MEMORY_RUN_ID}.log"
sudo grep -F -q 'parallel-shell-tool-oom-survived oom_group_kill=' "$MEMORY_STREAM_LOG" \
  || fail "CLI or unrelated Bash tool did not survive the offender group OOM"
sudo grep -F -q 'workload resource limit reached' "$MEMORY_STREAM_LOG" \
  || fail "memory-pressure resource event was not classified"
sudo grep -E -q 'memory_oom_kill=[1-9][0-9]*' "$MEMORY_STREAM_LOG" \
  || fail "memory-pressure diagnostics omitted the OOM event"
sudo grep -E -q 'memory_oom_group_kill=[1-9][0-9]*' "$MEMORY_STREAM_LOG" \
  || fail "memory-pressure diagnostics omitted the group OOM event"

echo "--- Pressure: prove tool-group OOM preserved sandbox reuse ---"
MEMORY_REUSE_RESULT=$(sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$MEMORY_CHAT_THREAD_ID" \
  --session-id "$MEMORY_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'true') \
  || fail "memory-pressure recovery did not preserve safe sandbox reuse"
printf '%s\n' "$MEMORY_REUSE_RESULT"
MEMORY_REUSE_RESULT_JSON=$(awk '/^\{/{line=$0} END{print line}' <<<"$MEMORY_REUSE_RESULT")
MEMORY_REUSE_RUN_ID=$(jq -r '.run_id // empty' <<<"$MEMORY_REUSE_RESULT_JSON")
[ -n "$MEMORY_REUSE_RUN_ID" ] || fail "memory-pressure reuse result omitted run ID"

echo "--- Pressure: prefer tools during Guest-wide OOM ---"
GLOBAL_MEMORY_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
GLOBAL_MEMORY_RESULT=$(sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --timeout 30 \
  --chat-thread-id "$GLOBAL_MEMORY_THREAD_ID" \
  --session-id e2e-process-containment-global-memory \
  --feature-flag sandboxReuse=true \
  --prompt '@guest-wide-tool-oom') \
  || fail "Guest-wide tool OOM did not preserve runtime and sibling"
printf '%s\n' "$GLOBAL_MEMORY_RESULT"
GLOBAL_MEMORY_JSON=$(awk '/^\{/{line=$0} END{print line}' <<<"$GLOBAL_MEMORY_RESULT")
GLOBAL_MEMORY_RUN_ID=$(jq -r '.run_id // empty' <<<"$GLOBAL_MEMORY_JSON")
[ -n "$GLOBAL_MEMORY_RUN_ID" ] || fail "Guest-wide OOM result omitted run ID"
GLOBAL_MEMORY_LOG="/var/lib/vm0-runner/logs/system-stream-${GLOBAL_MEMORY_RUN_ID}.log"
sudo grep -E -q 'parallel-shell-tool-oom-survived .*guest_wide=true memcg_ooms=0' \
  "$GLOBAL_MEMORY_LOG" || fail "Guest-wide OOM scope or recovery was not verified"
GLOBAL_REUSE_RESULT=$(sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$GLOBAL_MEMORY_THREAD_ID" \
  --session-id e2e-process-containment-global-memory \
  --feature-flag sandboxReuse=true --prompt 'true') \
  || fail "Guest-wide OOM did not preserve subsequent execution"
printf '%s\n' "$GLOBAL_REUSE_RESULT"
GLOBAL_REUSE_JSON=$(awk '/^\{/{line=$0} END{print line}' <<<"$GLOBAL_REUSE_RESULT")
GLOBAL_REUSE_RUN_ID=$(jq -r '.run_id // empty' <<<"$GLOBAL_REUSE_JSON")
[ -n "$GLOBAL_REUSE_RUN_ID" ] || fail "Guest-wide recovery omitted run ID"

echo "--- Pressure: runtime remains eligible without managed tools ---"
if RUNTIME_OOM_RESULT=$(sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --timeout 30 --prompt '@runtime-only-oom'); then
  fail "runtime-only OOM incorrectly succeeded"
fi
printf '%s\n' "$RUNTIME_OOM_RESULT"
RUNTIME_OOM_JSON=$(awk '/^\{/{line=$0} END{print line}' <<<"$RUNTIME_OOM_RESULT")
[ "$(jq -r '.exit_code' <<<"$RUNTIME_OOM_JSON")" = 137 ] \
  || fail "runtime-only OOM did not report exit 137"
RUNTIME_OOM_RUN_ID=$(jq -r '.run_id // empty' <<<"$RUNTIME_OOM_JSON")
[ -n "$RUNTIME_OOM_RUN_ID" ] || fail "runtime-only OOM result omitted run ID"

echo "--- Pressure: exhaust workload PID capacity and reclaim descendants ---"
PID_CHAT_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)
PID_SESSION_ID="e2e-process-containment-pids"
PID_PROMPT=$(cat <<'PROMPT'
sudo -n python3 - <<'PY'
import errno
import os
import pathlib
import signal
import time

marker = pathlib.Path("/tmp/vm0-process-containment")
marker.mkdir()
(marker / "pid-pressure-sandbox").touch()
relative = next(
    line.removeprefix("0::").strip()
    for line in pathlib.Path("/proc/self/cgroup").read_text().splitlines()
    if line.startswith("0::")
)
tool = pathlib.Path(f"/sys/fs/cgroup{relative}")
if tool.parent.name != "tools" or tool.parent.parent.name != "workload":
    raise RuntimeError(f"PID pressure is outside a Bash tool cgroup: {relative}")
tools = tool.parent
# Production leaves are uncapped until representative workload task counts are
# calibrated. This operation-local ceiling keeps the enforcement smoke fast.
(tools / "pids.max").write_text("64")
children = []
while True:
    try:
        pid = os.fork()
    except OSError as error:
        if error.errno != errno.EAGAIN:
            raise
        break
    if pid == 0:
        os.setsid()
        null = os.open("/dev/null", os.O_RDWR)
        for descriptor in (0, 1, 2):
            os.dup2(null, descriptor)
        if null > 2:
            os.close(null)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        while True:
            signal.pause()
    children.append(pid)

events = {}
for line in (tools / "pids.events").read_text().splitlines():
    key, value = line.split()
    events[key] = int(value)
if events.get("max", 0) == 0:
    raise RuntimeError("pids.max did not reject a workload fork")
print(f"pid-pressure-ready children={len(children)} max={events['max']}", flush=True)
time.sleep(2)
print(f"pid-pressure-complete children={len(children)}", flush=True)
PY
PROMPT
)
PID_RESULT=$(sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --timeout 30 \
  --chat-thread-id "$PID_CHAT_THREAD_ID" \
  --session-id "$PID_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt "$PID_PROMPT" \
  --active-input 'after=1s,text=pid-pressure-control') \
  || fail "PID-pressure workload did not finalize"
printf '%s\n' "$PID_RESULT"
PID_RESULT_JSON=$(awk '/^\{/{line=$0} END{print line}' <<<"$PID_RESULT")
PID_RUN_ID=$(jq -r '.run_id // empty' <<<"$PID_RESULT_JSON")
[ -n "$PID_RUN_ID" ] || fail "PID-pressure result omitted run ID"
PID_STREAM_LOG="/var/lib/vm0-runner/logs/system-stream-${PID_RUN_ID}.log"
sudo grep -F -q 'pid-pressure-complete children=' "$PID_STREAM_LOG" \
  || fail "PID-pressure workload did not reach the cgroup limit"
sudo grep -E -q 'pids_max=[1-9][0-9]*' "$PID_STREAM_LOG" \
  || fail "PID-pressure diagnostics omitted the pids.max event"

echo "--- Pressure: prove PID-exhaustion cleanup preserved sandbox reuse ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$PID_CHAT_THREAD_ID" \
  --session-id "$PID_SESSION_ID" \
  --feature-flag sandboxReuse=true \
  --prompt 'test -f /tmp/vm0-process-containment/pid-pressure-sandbox' \
  || fail "PID-pressure cleanup did not preserve safe sandbox reuse"

LOGS=$(sudo journalctl --no-pager "_SYSTEMD_INVOCATION_ID=$INVOCATION_ID" 2>&1) \
  || fail "failed to read runner logs"
printf '%s\n' "$LOGS" \
  | grep -F "run_id=$GLOBAL_REUSE_RUN_ID" \
  | grep -F 'job finished' | grep -F 'reused=true' >/dev/null \
  || fail "Guest-wide OOM recovery did not reuse its sandbox"
printf '%s\n' "$LOGS" \
  | grep -F "run_id=$RUNTIME_OOM_RUN_ID" \
  | grep -F 'job execution failed' \
  | grep -F 'resource_failure_kind="guest_memory_oom_killed"' >/dev/null \
  || fail "runtime-only OOM lost genuine agent-OOM attribution"
printf '%s\n' "$LOGS" \
  | grep -F "run_id=$MEMORY_RUN_ID" \
  | grep -F 'job finished' \
  >/dev/null \
  || fail "missing successful memory-pressure terminal log"
if printf '%s\n' "$LOGS" \
  | grep -F "run_id=$MEMORY_RUN_ID" \
  | grep -F 'job execution failed' >/dev/null; then
  fail "memory-pressure run was reported as failed"
fi
printf '%s\n' "$LOGS" \
  | grep -F "run_id=$MEMORY_REUSE_RUN_ID" \
  | grep -F 'job finished' \
  | grep -F 'reused=true' \
  >/dev/null \
  || fail "tool-group OOM follow-up did not reuse its sandbox"
if grep -F 'process control latency exceeded calibrated bound' <<<"$LOGS" >/dev/null; then
  fail "process control exceeded the calibrated 750ms bound under pressure"
fi

echo "--- Benchmark: Guest Agent ready boundary ---"
sudo "$AGENT_READY_BENCHMARK_WORKER" \
  "$BIN_DIR" \
  "$GROUP" \
  "$INVOCATION_ID" \
  "$AGENT_READY_BENCHMARK_SAMPLES"

echo "PASS: detached user/root descendants were reclaimed"
echo "PASS: mixed-identity leaked cleanup ${LEAK_CLEANUP_MS}ms; healthy cleanup preserved reuse"
echo "PASS: compressed CPU pressure kept process control live"
echo "PASS: Bash tool group OOM preserved the CLI, unrelated tool, and reuse in ${MEMORY_ELAPSED}s"
echo "PASS: pids.max cleanup reclaimed ${PID_INITIAL_MEMBERS} members in ${PID_CLEANUP_MS}ms"

sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
wait_for_unit_inactive
sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
trap - EXIT

echo "=== Process-containment test passed ==="
