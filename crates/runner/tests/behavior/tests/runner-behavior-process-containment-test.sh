#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=crates/runner/tests/behavior/runner-behavior-stage-support.sh
source "$SCRIPT_DIR/runner-behavior-stage-support.sh"

tmp=$(mktemp -d)
worker=""
release_fd=""
cleanup() {
  local status=$?
  trap - EXIT
  if [ -n "$worker" ]; then
    kill -TERM "$worker" 2> /dev/null || true
    # Bash may defer its TERM trap while waiting for the controlled Runner.
    if [ -n "$release_fd" ]; then
      printf 'release\n' >&"$release_fd" || true
    fi
    wait "$worker" 2> /dev/null || true
  fi
  rm -rf "$tmp" || true
  return "$status"
}
trap cleanup EXIT
mkdir -p "$tmp/bin"

cat > "$tmp/bin/ssh" << 'SSH'
#!/usr/bin/env bash
set -euo pipefail
count=0
if [ -f "$TEST_STATE/attempts" ]; then count=$(<"$TEST_STATE/attempts"); fi
count=$((count + 1))
printf '%s\n' "$count" > "$TEST_STATE/attempts"
cat > "$TEST_STATE/input"
if [ "$TEST_MODE" = unavailable ]; then exit 255; fi
if [ "$TEST_MODE" = corrupt ]; then printf 'corrupt bytes\n' > "$TEST_STATE/input"; fi
bash -c "$2" < "$TEST_STATE/input"
if [ "$TEST_MODE" = lost-response ] && [ "$count" -eq 1 ]; then exit 255; fi
SSH

cat > "$tmp/bin/sudo" << 'SUDO'
#!/usr/bin/env bash
set -euo pipefail
if [ "$TEST_MODE" = install-failed ] && [ "$1" = install ]; then exit 42; fi
case "$TEST_MODE" in
  scenario-failed|diagnostic-failed|cancelled|stop-unknown) ;;
  *) exec "$@" ;;
esac
case "$1:$2" in
  /fake/bin/runner:service)
    case "$3" in
      start) touch "$TEST_STATE/active" ;;
      stop)
        if [ "$TEST_MODE" = stop-unknown ] && [ -f "$TEST_STATE/submitted" ]; then
          exit 42
        fi
        rm -f "$TEST_STATE/active"
        ;;
      *) exit 2 ;;
    esac
    ;;
  /fake/bin/runner:local)
    # The actual first scenario submits its guest program; reject it at Runner.
    test "$3" = submit
    test ! -f "$TEST_STATE/submitted"
    # Script bytes must not become the Runner process's input stream.
    if IFS= read -r unexpected_input; then
      echo "scenario commands leaked to Runner stdin" >&2
      exit 2
    fi
    touch "$TEST_STATE/submitted"
    test "$4" = --timeout
    test "$5" -gt 30
    test "$5" -le 240
    if [ "$TEST_MODE" = cancelled ]; then
      printf 'ready\n' > "$TEST_STATE/ready"
      read -r release < "$TEST_STATE/release"
      exit 0
    fi
    echo 'Runner rejected the managed-task scenario' >&2
    exit 73
    ;;
  systemctl:is-active)
    test -f "$TEST_STATE/active"
    ;;
  systemctl:show)
    case "$4" in
      --property=InvocationID) echo fixture-invocation ;;
      --property=ActiveState)
        if [ -f "$TEST_STATE/active" ]; then
          if [ "$TEST_MODE" = stop-unknown ] && [ -f "$TEST_STATE/submitted" ]; then
            exit 42
          fi
          echo active
        else
          echo inactive
        fi
        ;;
      *) exit 2 ;;
    esac
    ;;
  journalctl:--no-pager)
    test "$5" = _SYSTEMD_INVOCATION_ID=fixture-invocation
    test -f "$TEST_STATE/active"
    test ! -f "$TEST_STATE/fixture-removed"
    touch "$TEST_STATE/journal-read"
    if [ "$TEST_MODE" = diagnostic-failed ]; then exit 43; fi
    printf 'run_id=12345678-1234-4234-8234-123456789abc job started\n'
    printf 'run_id=../../unrelated invalid identity\n'
    ;;
  tail:-n)
    test "$4" = /var/lib/vm0-runner/logs/system-stream-12345678-1234-4234-8234-123456789abc.log
    test -f "$TEST_STATE/active"
    test ! -f "$TEST_STATE/fixture-removed"
    touch "$TEST_STATE/stream-read"
    echo 'retained Guest evidence'
    ;;
  cat:--)
    case "$3" in
      "$TEST_STATE/scenarios/managed-tasks.sh"|"$TEST_STATE/scenarios/submit.sh") ;;
      *) exit 2 ;;
    esac
    exec cat -- "$3"
    ;;
  rm:-rf)
    # Record fixture deletion while keeping privileged host paths isolated.
    test "$3" = /var/lib/vm0-runner/groups/vm0/process-containment-test-case
    if [ "$#" -eq 4 ]; then
      test "$4" = /var/lib/vm0-runner/runners/test-case-process-containment
      touch "$TEST_STATE/fixture-removed"
    fi
    ;;
  *) echo "unexpected host boundary: $*" >&2; exit 2 ;;
esac
SUDO

cat > "$tmp/bin/sleep" << 'SLEEP'
#!/usr/bin/env bash
exit 0
SLEEP
chmod +x "$tmp/bin/ssh" "$tmp/bin/sudo" "$tmp/bin/sleep"

stage_case() {
  local name=$1
  local expected_status=$2
  local expected_attempts=$3
  local state="$tmp/$name"
  local status=0
  mkdir -p "$state/temp"
  printf 'previous verified worker\n' > "$state/published.sh"

  TEST_MODE="$name" TEST_STATE="$state" TMPDIR="$state/temp" PATH="$tmp/bin:$PATH" \
    stage_runner_behavior_support synthetic-host \
    "$SCRIPT_DIR/runner-behavior-process-containment-managed-tasks.sh" \
    "$state/published.sh" > "$state/output" 2>&1 || status=$?
  if [ "$status" -ne "$expected_status" ]; then
    cat "$state/output" >&2
    echo "expected $name status $expected_status; got $status" >&2
    exit 1
  fi
  test "$(< "$state/attempts")" = "$expected_attempts"
  if [ "$status" -eq 0 ]; then
    cmp "$SCRIPT_DIR/runner-behavior-process-containment-managed-tasks.sh" "$state/published.sh"
    test -x "$state/published.sh"
  else
    test "$(< "$state/published.sh")" = 'previous verified worker'
  fi
  test -z "$(find "$state/temp" -mindepth 1 -print -quit)"
  test -z "$(find "$state" -name 'published.sh.*' -print -quit)"
}

stage_case success 0 1
stage_case lost-response 0 2
stage_case corrupt 1 1
stage_case install-failed 42 1
stage_case unavailable 255 3

unsafe_status=0
TEST_MODE=success TEST_STATE="$tmp/unsafe" PATH="$tmp/bin:$PATH" \
  stage_runner_behavior_support synthetic-host \
  "$SCRIPT_DIR/runner-behavior-process-containment-managed-tasks.sh" \
  "$tmp/../unsafe.sh" > "$tmp/unsafe-output" 2>&1 || unsafe_status=$?
test "$unsafe_status" -eq 2
test ! -e "$tmp/unsafe"

for scenario in scenario-failed diagnostic-failed cancelled stop-unknown; do
  state="$tmp/$scenario"
  mkdir -p "$state/scenarios" "$state/temp"
  ln -s "$SCRIPT_DIR/runner-behavior-process-containment-managed-tasks.sh" "$state/scenarios/managed-tasks.sh"
  ln -s "$SCRIPT_DIR/runner-behavior-process-containment-lifecycle.sh" "$state/scenarios/lifecycle.sh"
  ln -s "$SCRIPT_DIR/runner-behavior-process-containment-resource-pressure.sh" "$state/scenarios/resource-pressure.sh"
  ln -s "$SCRIPT_DIR/runner-behavior-process-containment-submit.sh" "$state/scenarios/submit.sh"
  mkfifo "$state/ready" "$state/release"
  exec {ready_fd}<> "$state/ready"
  exec {release_fd}<> "$state/release"
  TEST_MODE="$scenario" TEST_STATE="$state" TMPDIR="$state/temp" PATH="$tmp/bin:$PATH" \
    bash "$SCRIPT_DIR/runner-behavior-process-containment-remote.sh" \
    /fake/bin test-case "$state/scenarios" < /dev/null > "$state/output" 2>&1 &
  worker=$!
  expected_status=1
  if [ "$scenario" = cancelled ]; then
    read -r -t 10 ready <&"$ready_fd"
    test "$ready" = ready
    kill -TERM "$worker"
    printf 'release\n' >&"$release_fd"
    expected_status=143
  fi
  status=0
  wait "$worker" || status=$?
  worker=""
  exec {ready_fd}>&-
  exec {release_fd}>&-
  release_fd=""
  if [ "$status" -ne "$expected_status" ]; then
    cat "$state/output" >&2
    echo "unexpected $scenario status: $status" >&2
    exit 1
  fi
  test -f "$state/submitted"
  test -f "$state/journal-read"
  if [ "$scenario" = stop-unknown ]; then
    test ! -e "$state/fixture-removed"
    test -f "$state/active"
  else
    test -f "$state/fixture-removed"
    test ! -e "$state/active"
  fi
  if [ "$scenario" != diagnostic-failed ]; then
    test -f "$state/stream-read"
    grep -Fq 'retained Guest evidence' "$state/output"
  fi
  test -z "$(find "$state/temp" -mindepth 1 -print -quit)"
  if grep -Fq 'Process-containment test passed' "$state/output"; then
    echo 'scenario failure was reported as suite success' >&2
    exit 1
  fi
done

echo 'runner-behavior-process-containment-test: ok'
