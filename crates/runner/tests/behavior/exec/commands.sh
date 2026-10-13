#!/usr/bin/env bash
set -euo pipefail

BIN_DIR=$1
SANDBOX_ID=$2
fail() { echo "FAIL: $1"; exit 1; }

# Test 1: privilege boundary
echo "--- Test: privilege boundary ---"
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- id -u) || \
  fail "ordinary exec failed"
[ "$OUTPUT" = "1000" ] || fail "ordinary exec expected UID 1000, got: $OUTPUT"
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" --sudo -- id -u) || \
  fail "privileged exec failed"
[ "$OUTPUT" = "0" ] || fail "privileged exec expected UID 0, got: $OUTPUT"
echo "PASS: privilege boundary"

# Test 3: one-shot exec owns detached descendants, including through the
# production non-sudo `su` boundary. The long-running job above can own another
# valid leaf concurrently, so record and verify this exec's exact leaf.
echo "--- Test: one-shot process containment ---"
ONE_SHOT_COMMAND=$(cat <<'SCRIPT'
set -eu
identity=/tmp/vm0-one-shot-containment.identity
group_file=/tmp/vm0-one-shot-containment.group
rm -f "$identity" "$group_file"
relative=$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup)
case "$relative" in
  /vm0-exec/exec-*/workload) ;;
  *) echo "unexpected one-shot cgroup: $relative" >&2; exit 1 ;;
esac
operation=${relative%/workload}
own_group=${operation##*/}
test -f "/sys/fs/cgroup$operation/workload/cpu.max"
test -f "/sys/fs/cgroup$operation/workload/memory.max"
test -f "/sys/fs/cgroup$operation/workload/pids.max"
printf '%s\n' "$own_group" > "$group_file"
setsid python3 -c 'import os, pathlib, signal, time; p=pathlib.Path("/tmp/vm0-one-shot-containment.identity"); fields=pathlib.Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split(); signal.signal(signal.SIGTERM, signal.SIG_IGN); p.write_text(f"{os.getpid()} {fields[19]}\n"); time.sleep(300)' </dev/null >/dev/null 2>&1 &
for _ in $(seq 1 100); do
  [ -s "$identity" ] && break
  sleep 0.01
done
test -s "$identity"
SCRIPT
)
sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- sh -c "$ONE_SHOT_COMMAND" \
  || fail "one-shot descendant setup failed"
VERIFY_ONE_SHOT_COMMAND=$(cat <<'SCRIPT'
set -eu
identity=/tmp/vm0-one-shot-containment.identity
group_file=/tmp/vm0-one-shot-containment.group
read -r pid start_time < "$identity"
if current_identity=$(awk '{sub(/^.*\) /, ""); print $1, $20}' "/proc/$pid/stat" 2>/dev/null); then
  current_state=${current_identity%% *}
  current_start=${current_identity#* }
  case "$current_state" in
    Z|X|x) ;;
    *)
      [ "$current_start" != "$start_time" ] || {
        echo "one-shot descendant is still running: pid=$pid" >&2
        exit 1
      }
      ;;
  esac
fi
base=/sys/fs/cgroup/vm0-exec
relative=$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup)
case "$relative" in
  /vm0-exec/exec-*/workload) ;;
  *) echo "unexpected verification cgroup: $relative" >&2; exit 1 ;;
esac
operation=${relative%/workload}
own_group=${operation##*/}
test -n "$own_group"
test -d "$base/$own_group"
old_group=$(cat "$group_file")
case "$old_group" in
  exec-*) ;;
  *) echo "unexpected recorded one-shot cgroup: $old_group" >&2; exit 1 ;;
esac
[ "$old_group" != "$own_group" ] || {
  echo "one-shot cgroup was reused: $old_group" >&2
  exit 1
}
[ ! -e "$base/$old_group" ] || {
  echo "one-shot cgroup leaf survived cleanup: $old_group" >&2
  exit 1
}
SCRIPT
)
sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- sh -c "$VERIFY_ONE_SHOT_COMMAND" \
  || fail "one-shot descendant or cgroup leaf survived cleanup"
echo "PASS: one-shot process containment"

# Test 4: exit code propagation
echo "--- Test: exit code propagation ---"
sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- false && fail "expected non-zero exit"
echo "PASS: exit code propagation"

# Test 5: prefix matching
echo "--- Test: prefix matching ---"
PREFIX=$(echo "$SANDBOX_ID" | cut -c1-8)
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$PREFIX" -- hostname)
[ -n "$OUTPUT" ] || fail "prefix match returned empty output"
echo "PASS: prefix matching"

# Test 6: argv boundary preservation — regression guard for #9019.
# NOTE: each assertion relies on the surrounding bash (this
# heredoc, running on the metal runner) to tokenise quoted
# arguments and pass them to runner as separate argv entries.
# For example `echo "hello world"` reaches runner as
# ["echo", "hello world"] (two tokens); runner then shell-quotes
# each before sending to the guest sh.
echo "--- Test: argv boundary preservation ---"
# Space in an argument is preserved as one token
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- echo "hello world")
[ "$OUTPUT" = "hello world" ] || fail "space in arg: got '$OUTPUT'"
# Single quote in an argument is escaped correctly
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- echo "it's working")
[ "$OUTPUT" = "it's working" ] || fail "single quote in arg: got '$OUTPUT'"
# Shell metachars must NOT be expanded by the guest shell
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- echo '$HOME')
[ "$OUTPUT" = "\$HOME" ] || fail "variable expanded: got '$OUTPUT'"
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- echo '*.nonexistent')
[ "$OUTPUT" = '*.nonexistent' ] || fail "glob expanded: got '$OUTPUT'"
# Backtick command substitution must NOT be executed (injection guard)
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- echo '`date`')
[ "$OUTPUT" = "\`date\`" ] || fail "backtick expanded: got '$OUTPUT'"
# Double quote inside an argument survives the round-trip
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- echo 'say "hi"')
[ "$OUTPUT" = 'say "hi"' ] || fail "double quote in arg: got '$OUTPUT'"
# Non-ASCII UTF-8 in an argument
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- echo "你好")
[ "$OUTPUT" = "你好" ] || fail "utf-8 arg: got '$OUTPUT'"
# Explicit shell: pipes and redirects work through `sh -c`
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- sh -c 'printf abc | wc -c')
[ "$(echo "$OUTPUT" | tr -d ' ')" = '3' ] || fail "sh -c pipe: got '$OUTPUT'"
# env VAR=val PROG: env (not shell) sets the variable for PROG
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- env FOO=bar printenv FOO)
[ "$OUTPUT" = 'bar' ] || fail "env VAR=val: got '$OUTPUT'"
# Path containing a space — the original issue case
sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- sh -c 'echo content > "/tmp/spaced file.txt"'
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- cat "/tmp/spaced file.txt")
[ "$OUTPUT" = 'content' ] || fail "space in path: got '$OUTPUT'"
sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- rm "/tmp/spaced file.txt"
# --sudo flag must not bypass argv quoting
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" --sudo -- echo "root with space")
[ "$OUTPUT" = "root with space" ] || fail "--sudo quoting: got '$OUTPUT'"
echo "PASS: argv boundary preservation"
