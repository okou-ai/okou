#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUBMIT="$SCRIPT_DIR/runner-behavior-process-containment-submit.sh"
tmp=$(mktemp -d)
child=""
cleanup() {
  local status=$?
  trap - EXIT
  if [ -n "$child" ]; then
    kill -TERM "$child" 2> /dev/null || true
    wait "$child" 2> /dev/null || true
  fi
  rm -rf "$tmp" || true
  return "$status"
}
trap cleanup EXIT
mkdir "$tmp/bin"
mkfifo "$tmp/ready" "$tmp/release"
# Open both ends before starting the child so even an early command failure
# reaches the bounded read instead of blocking while opening the FIFO.
exec {ready_fd}<> "$tmp/ready"
exec {release_fd}<> "$tmp/release"

cat > "$tmp/bin/sudo" << 'SUDO'
#!/usr/bin/env bash
exec "$@"
SUDO
cat > "$tmp/bin/runner" << 'RUNNER'
#!/usr/bin/env bash
set -euo pipefail
test "$1" = local
test "$2" = submit
test "$3" = --timeout
remaining=$4
shift 4
test "$1" = --group && test "$2" = synthetic-test
read -r uptime_seconds _ < /proc/uptime
test "$remaining" -gt 30
test "$remaining" -le "$((PROCESS_CONTAINMENT_DEADLINE_UPTIME_SECONDS - ${uptime_seconds%%.*} + 1))"
printf '%s\n' "$$" > "$TEST_STATE/pid"
printf 'fixture-complete\n' > "$TEST_STATE/ready"
read -r release < "$TEST_STATE/release"
if [ "$release" = fail ]; then exit 73; fi
printf '{"exit_code":0}\n'
RUNNER
chmod +x "$tmp/bin/sudo" "$tmp/bin/runner"

# The real command remains owned until the fake external Runner publishes its
# final result, even after its fixture-complete observation. No clock sleeps.
for outcome in complete fail; do
  read -r uptime_seconds _ < /proc/uptime
  PROCESS_CONTAINMENT_DEADLINE_UPTIME_SECONDS=$((${uptime_seconds%%.*} + 90)) \
    TEST_STATE="$tmp" PATH="$tmp/bin:$PATH" \
    bash "$SUBMIT" "$tmp/bin" --group synthetic-test > "$tmp/output" 2>&1 &
  child=$!
  read -r -t 10 ready <&"$ready_fd"
  test "$ready" = fixture-complete
  test "$(< "$tmp/pid")" = "$child"
  test ! -s "$tmp/output"
  printf '%s\n' "$outcome" >&"$release_fd"
  status=0
  wait "$child" || status=$?
  child=""
  if [ "$outcome" = complete ]; then
    test "$status" -eq 0
    test "$(< "$tmp/output")" = '{"exit_code":0}'
  else
    test "$status" -eq 73
  fi
done

for budget in 1 '' invalid 0001 99999999999999999999999; do
  rm -f "$tmp/pid"
  status=0
  PROCESS_CONTAINMENT_DEADLINE_UPTIME_SECONDS="$budget" TEST_STATE="$tmp" PATH="$tmp/bin:$PATH" \
    bash "$SUBMIT" "$tmp/bin" --group synthetic-test > "$tmp/output" 2>&1 || status=$?
  if [ "$budget" = 1 ]; then
    test "$status" -eq 1
    grep -Fq 'budget exhausted' "$tmp/output"
  else
    test "$status" -eq 2
  fi
  test ! -e "$tmp/pid"
done

echo 'runner-behavior-process-containment-submit-test: ok'
