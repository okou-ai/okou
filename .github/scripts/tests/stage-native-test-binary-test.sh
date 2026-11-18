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
  rm -f -- "$destination" "$destination".upload.*
  rm -rf -- "$test_root"
}
trap cleanup EXIT
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
[ "$1" = metal@host.vm3.ai ]
count=0
if [ -f "$CASE_DIR/count" ]; then count=$(cat "$CASE_DIR/count"); fi
count=$((count + 1))
echo "$count" > "$CASE_DIR/count"
case "$SCENARIO" in
  permanent) exit 7 ;;
  exhausted) exit 255 ;;
  cancelled)
    echo "$$" > "$CASE_DIR/ssh.pid"
    trap 'exit 143' TERM
    echo ready > "$CASE_DIR/ready"
    read -r _ < "$CASE_DIR/hold"
    ;;
  guarded-timeout)
    if [ "$count" -eq 1 ]; then
      echo "$$" > "$CASE_DIR/ssh.pid"
      trap 'exit 143' TERM
      read -r _ < "$CASE_DIR/hold"
    fi
    ;;
  corrupt)
    head -c 3 | sh -c "$2"
    exit $?
    ;;
  partial | timeout | pipe)
    if [ "$count" -eq 1 ]; then
      head -c 3 | sh -c "$2" || true
      case "$SCENARIO" in
        timeout) exit 124 ;;
        pipe) exit 141 ;;
        *) exit 255 ;;
      esac
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

for scenario in success partial timeout pipe lost-ack late-writer corrupt permanent exhausted; do
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
if kill -0 "$(cat "$case_dir/ssh.pid")" 2>/dev/null; then
  echo 'timed-out guarded upload retained its SSH child' >&2
  exit 1
fi

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
test "$status" -eq 143
test "$(cat "$case_dir/count")" -eq 1
if kill -0 "$(cat "$case_dir/ssh.pid")" 2>/dev/null; then
  echo 'cancelled upload retained its SSH child' >&2
  exit 1
fi
echo 'stage-native-test-binary: verified publication, isolated writers and cancellation passed'
