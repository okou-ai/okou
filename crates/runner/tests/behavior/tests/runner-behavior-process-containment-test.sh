#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=crates/runner/tests/behavior/runner-behavior-stage-support.sh
source "$SCRIPT_DIR/runner-behavior-stage-support.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

cat > "$tmp/bin/ssh" <<'SSH'
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

cat > "$tmp/bin/sudo" <<'SUDO'
#!/usr/bin/env bash
set -euo pipefail
if [ "$TEST_MODE" = install-failed ] && [ "$1" = install ]; then exit 42; fi
if [ "$TEST_MODE" != scenario-failed ]; then exec "$@"; fi
case "$1:$2" in
  /fake/bin/runner:service)
    case "$3" in
      start) touch "$TEST_STATE/active" ;;
      stop) rm -f "$TEST_STATE/active" ;;
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
    echo 'Runner rejected the managed-task scenario' >&2
    exit 73
    ;;
  systemctl:is-active)
    test -f "$TEST_STATE/active"
    ;;
  systemctl:show)
    echo fixture-invocation
    ;;
  cat:--)
    test "$3" = "$TEST_STATE/scenarios/managed-tasks.sh"
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

cat > "$tmp/bin/sleep" <<'SLEEP'
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
  test "$(<"$state/attempts")" = "$expected_attempts"
  if [ "$status" -eq 0 ]; then
    cmp "$SCRIPT_DIR/runner-behavior-process-containment-managed-tasks.sh" "$state/published.sh"
    test -x "$state/published.sh"
  else
    test "$(<"$state/published.sh")" = 'previous verified worker'
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

state="$tmp/scenario-failed"
mkdir -p "$state/scenarios" "$state/temp"
ln -s "$SCRIPT_DIR/runner-behavior-process-containment-managed-tasks.sh" "$state/scenarios/managed-tasks.sh"
ln -s "$SCRIPT_DIR/runner-behavior-process-containment-lifecycle.sh" "$state/scenarios/lifecycle.sh"
ln -s "$SCRIPT_DIR/runner-behavior-process-containment-resource-pressure.sh" "$state/scenarios/resource-pressure.sh"
status=0
TEST_MODE=scenario-failed TEST_STATE="$state" TMPDIR="$state/temp" PATH="$tmp/bin:$PATH" \
  bash "$SCRIPT_DIR/runner-behavior-process-containment-remote.sh" \
    /fake/bin test-case "$state/scenarios" < /dev/null > "$state/output" 2>&1 || status=$?
test "$status" -eq 1
test -f "$state/submitted"
test -f "$state/fixture-removed"
test ! -e "$state/active"
test -z "$(find "$state/temp" -mindepth 1 -print -quit)"
grep -Fq 'Runner rejected the managed-task scenario' "$state/output"
if grep -Fq 'Process-containment test passed' "$state/output"; then
  echo 'scenario failure was reported as suite success' >&2
  exit 1
fi

echo 'runner-behavior-process-containment-test: ok'
