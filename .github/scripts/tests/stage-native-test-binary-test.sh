#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
helper="$repo_root/.github/scripts/runner/stage-native-test-binary.sh"
system_timeout=$(command -v timeout)
test_root=$(mktemp -d)
destination="/tmp/okou-native-stage-test-$$"
cleanup() {
  for pid_file in "$test_root"/*/writer.pid; do
    [ -f "$pid_file" ] || continue
    kill -TERM -- "-$(cat "$pid_file")" 2>/dev/null || true
  done
  rm -rf -- "$destination" "$destination".upload.*
  rm -rf -- "$test_root"
}
trap cleanup EXIT

assert_ssh_exited() {
  local case_dir=$1 initial current pid
  local -a initial_fields current_fields
  IFS= read -r initial < "$case_dir/ssh.stat"
  pid=${initial%% *}
  if IFS= read -r current 2>/dev/null < "/proc/$pid/stat"; then
    # Compare start times to identify the original process. A reaper may
    # still have an exited process in its table after staging has returned.
    read -r -a initial_fields <<< "${initial##*) }"
    read -r -a current_fields <<< "${current##*) }"
    if [[ ${current_fields[19]} != "${initial_fields[19]}" ||
      ${current_fields[0]} == Z || ${current_fields[0]} == X ]]; then
      return 0
    fi
    echo "staging transfer $pid is still running (state=${current_fields[0]})" >&2
  elif [[ -d /proc/$pid ]]; then
    echo "could not read the staging transfer's process state: $pid" >&2
  else
    return 0
  fi
  cat "$case_dir/out" >&2
  return 1
}

mkdir "$test_root/bin"
cat >"$test_root/test binary" <<'BINARY'
#!/usr/bin/env bash
echo native-test
BINARY
chmod +x "$test_root/test binary"

cat >"$test_root/bin/ssh" <<'SSH'
#!/usr/bin/env bash
set -euo pipefail
# The guarded transport's probe must leave the transfer's stdin untouched.
if [ "${!#}" = true ]; then exit 0; fi
if [ "$1" = -n ]; then shift; fi
[ "$1" = metal@host.vm3.ai ]
if [[ "$2" == *native-chunk* ]]; then
  read -r _ index _ <<<"${2##*native-chunk }"
  printf '%s\n' "$index" >> "$CASE_DIR/chunks"
  case "$SCENARIO" in
    chunk-corrupt) head -c 3 | sh -c "$2"; exit $? ;;
    chunk-exhausted) exit 255 ;;
  esac
  if [ "$index" = "'1'" ] && [ "$SCENARIO" = chunk-reset ]; then
    tries=$(grep -Fxc -- "$index" "$CASE_DIR/chunks")
    if [ "$tries" -lt 3 ]; then
      head -c 1048576 | sh -c "$2" || true
      echo 1048576 >> "$CASE_DIR/bytes"
      exit 255
    fi
  fi
  stat -Lc %s "/proc/$$/fd/0" >> "$CASE_DIR/bytes"
fi

record_ssh_process() {
  local stat
  IFS= read -r stat < "/proc/$$/stat"
  printf '%s\n' "$stat" > "$CASE_DIR/ssh.stat"
}

count=0
if [ -f "$CASE_DIR/count" ]; then count=$(cat "$CASE_DIR/count"); fi
count=$((count + 1))
echo "$count" > "$CASE_DIR/count"
case "$SCENARIO" in
  permanent) exit 7 ;;
  exhausted) exit 255 ;;
  cancelled)
    trap 'exit 143' TERM
    record_ssh_process
    echo ready > "$CASE_DIR/ready"
    read -r _ < "$CASE_DIR/hold"
    ;;
  guarded-timeout)
    if [ "$count" -eq 1 ]; then
      trap 'exit 143' TERM
      record_ssh_process
      read -r _ < "$CASE_DIR/hold"
    fi
    ;;
  corrupt)
    head -c 3 | sh -c "$2"
    exit $?
    ;;
  pipe)
    if [ "$count" -eq 1 ]; then
      head -c 3 | sh -c "$2" || true
      exit 141
    fi
    ;;
  late-writer)
    if [ "$count" -eq 1 ]; then
      # Real remote program waits with a partial candidate after its SSH
      # client has failed; second transfer will publish before it resumes.
      cat > "$CASE_DIR/input"
      timeout --kill-after=1s 20s bash -c '
        {
          head -c 3 "$CASE_DIR/input"
          read -r _ < "$CASE_DIR/release"
          printf "stale truncated data"
        } | sh -c "$1" || true
        echo done > "$CASE_DIR/done"
      ' late-writer "$2" > "$CASE_DIR/late.log" 2>&1 &
      echo "$!" > "$CASE_DIR/writer.pid"
      exit 255
    fi
    sh -c "$2"
    echo release > "$CASE_DIR/release"
    read -r _ < "$CASE_DIR/done"
    exit 0
    ;;
esac
sh -c "$2"
if [ "$SCENARIO" = lost-ack ] && [ "$count" -eq 1 ]; then exit 255; fi
SSH
chmod +x "$test_root/bin/ssh"

for scenario in success pipe lost-ack late-writer corrupt permanent exhausted; do
  case_dir="$test_root/$scenario"
  mkdir "$case_dir"
  mkfifo "$case_dir/release" "$case_dir/done"
  rm -f -- "$destination"
  status=0
  PATH="$test_root/bin:$PATH" CASE_DIR="$case_dir" SCENARIO="$scenario" \
    bash "$helper" "$test_root/test binary" metal@host.vm3.ai "$destination" \
    >"$case_dir/out" 2>&1 || status=$?
  case "$scenario" in
    corrupt)
      expected=1
      attempts=1
      ;;
    permanent)
      expected=7
      attempts=1
      ;;
    exhausted)
      expected=255
      attempts=3
      ;;
    success)
      expected=0
      attempts=1
      ;;
    *)
      expected=0
      attempts=2
      ;;
  esac
  if [ "$status" -ne "$expected" ]; then
    cat "$case_dir/out" >&2
    echo "unexpected staging result for $scenario: $status" >&2
    exit 1
  fi
  test "$(cat "$case_dir/count")" -eq "$attempts"
  if [ "$status" -eq 0 ]; then
    cmp "$test_root/test binary" "$destination"
    test -x "$destination"
  else
    test ! -e "$destination"
  fi
  rm -f "$case_dir/writer.pid"
done

large="$test_root/large-binary"
ln -s "$large" "$test_root/linked-binary"
for scenario in chunk-healthy chunk-reset; do
  case_dir="$test_root/$scenario"
  mkdir "$case_dir"
  cp "$test_root/test binary" "$large"
  if [ "$scenario" = chunk-healthy ]; then
    size=262978928
    expected_chunks=4
    expected_bytes=$size
  else
    size=332179440
    expected_chunks=7
    expected_bytes=$((size + 2 * 1048576))
  fi
  truncate -s "$size" "$large"
  started=$SECONDS
  if ! PATH="$test_root/bin:$PATH" CASE_DIR="$case_dir" SCENARIO="$scenario" \
    bash "$helper" "$test_root/linked-binary" metal@host.vm3.ai "$destination" >"$case_dir/out" 2>&1; then
    cat "$case_dir/out" >&2
    exit 1
  fi
  cmp "$large" "$destination"
  test -x "$destination"
  test "$(wc -l <"$case_dir/chunks")" -eq "$expected_chunks"
  test "$(awk '{bytes += $1} END {print bytes}' "$case_dir/bytes")" -eq "$expected_bytes"
  if compgen -G "$destination.upload.*" >/dev/null; then
    echo "chunk staging directory leaked" >&2
    exit 1
  fi
  printf '%s: %s bytes, %s chunk attempts, %s seconds\n' \
    "$scenario" "$expected_bytes" "$expected_chunks" "$((SECONDS - started))"
  rm -f -- "$destination"
done

for scenario in chunk-corrupt chunk-exhausted; do
  case_dir="$test_root/$scenario"
  mkdir "$case_dir"
  status=0
  PATH="$test_root/bin:$PATH" CASE_DIR="$case_dir" SCENARIO="$scenario" \
    bash "$helper" "$large" metal@host.vm3.ai "$destination" >"$case_dir/out" 2>&1 || status=$?
  if [ "$scenario" = chunk-corrupt ]; then
    test "$status" -eq 1
    test "$(wc -l <"$case_dir/chunks")" -eq 1
  else
    test "$status" -eq 255
    test "$(wc -l <"$case_dir/chunks")" -eq 3
  fi
  test ! -e "$destination"
  if compgen -G "$destination.upload.*" >/dev/null; then
    echo "failed upload leaked staging files" >&2
    exit 1
  fi
done

# Exercise the real guarded SSH caller, including its cancellation cleanup.
# Shorten only the external upload deadline; retain GNU timeout and the real
# kill-after intervals so a forced kill cannot masquerade as retryable timeout.
case_dir="$test_root/guarded-timeout"
mkdir -p "$case_dir/state" "$test_root/guard-bin" "$test_root/clock-bin"
mkfifo "$case_dir/hold"
ln -s "$repo_root/.github/scripts/runner/cloudflare-ssh-command.sh" "$test_root/guard-bin/ssh"
cat >"$test_root/clock-bin/timeout" <<'TIMEOUT'
#!/usr/bin/env bash
set -euo pipefail
arguments=("$@")
index=0
while [[ "${arguments[$index]}" == --* ]]; do index=$((index + 1)); done
if [ "${arguments[$((index + 1))]:-}" = ssh ]; then arguments[$index]=3s; fi
exec "$STAGE_TEST_REAL_TIMEOUT" "${arguments[@]}"
TIMEOUT
chmod +x "$test_root/clock-bin/timeout"
rm -f -- "$destination"
status=0
PATH="$test_root/clock-bin:$test_root/guard-bin:$PATH" \
  CASE_DIR="$case_dir" SCENARIO=guarded-timeout STAGE_TEST_REAL_TIMEOUT="$system_timeout" \
  OKOU_CLOUDFLARE_SSH_REAL_SSH="$test_root/bin/ssh" \
  OKOU_CLOUDFLARE_SSH_STATE_DIR="$case_dir/state" \
  OKOU_CLOUDFLARE_SSH_SCRIPTS_DIR="$repo_root/.github/scripts/runner" RUNNER_TEMP="$case_dir" \
  bash "$helper" "$test_root/test binary" metal@host.vm3.ai "$destination" \
  >"$case_dir/out" 2>&1 || status=$?
if [ "$status" -ne 0 ]; then
  cat "$case_dir/out" >&2
  echo "guarded transfer deadline did not recover: $status" >&2
  exit 1
fi
test "$(cat "$case_dir/count")" -eq 2
cmp "$test_root/test binary" "$destination"
assert_ssh_exited "$case_dir"

# Cancellation retires the external transfer rather than submitting again.
case_dir="$test_root/cancelled"
mkdir "$case_dir"
mkfifo "$case_dir/hold" "$case_dir/ready"
PATH="$test_root/bin:$PATH" CASE_DIR="$case_dir" SCENARIO=cancelled \
  bash "$helper" "$test_root/test binary" metal@host.vm3.ai "$destination" \
  >"$case_dir/out" 2>&1 &
owner=$!
# read -t cannot bound the shell's preceding FIFO open if the child exits early.
if ! ready_marker=$("$system_timeout" --kill-after=1s 10s head -n 1 "$case_dir/ready") || [ "$ready_marker" != ready ]; then
  kill -TERM "$owner" 2>/dev/null || true
  wait "$owner" 2>/dev/null || true
  cat "$case_dir/out" >&2
  echo 'upload did not become ready for cancellation' >&2
  exit 1
fi
kill -TERM "$owner"
status=0
wait "$owner" || status=$?
if [ "$status" -ne 143 ]; then
  cat "$case_dir/out" >&2
  echo "cancelled transfer returned $status, expected 143" >&2
  exit 1
fi
test "$(cat "$case_dir/count")" -eq 1
assert_ssh_exited "$case_dir"
echo 'stage-native-test-binary: verified publication, isolated writers and cancellation passed'
