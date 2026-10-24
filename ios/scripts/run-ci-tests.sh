#!/usr/bin/env bash
# Resolve and compile before booting the exact simulator for native tests.
# Keep simulator post-boot system initialization out of compilation.
# Uses ci-test.sh's RUNNER_TEMP and IOS_TEST_DESTINATION contracts.
set -euo pipefail
# Each owned job gets a process group, including its compiler/simctl descendants.
set -m
repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"
ios_preboot_pid=""
ios_phase_pid=""
cleanup() {
  local ios_child
  for ios_child in "$ios_preboot_pid" "$ios_phase_pid"; do
    if [[ -n "$ios_child" ]]; then
      kill -TERM -- "-$ios_child" 2>/dev/null || true
      wait "$ios_child" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ios_test_mode=${IOS_CI_TEST_MODE:-split}
case "$ios_test_mode" in
  split) ;;
  single)
    if [[ -n "${GITHUB_EVENT_NAME:-}" && "${GITHUB_EVENT_NAME:-}" != workflow_dispatch ]]; then
      echo 'Single-process experiments require an explicit manual run' >&2
      exit 2
    fi
    ;;
  *) echo "Unknown iOS test execution mode: $ios_test_mode" >&2; exit 2 ;;
esac
echo "iOS test execution mode: $ios_test_mode"

ios_prepare_started=$SECONDS
bash ios/scripts/ci-test.sh prepare &
ios_phase_pid=$!
wait "$ios_phase_pid"
ios_phase_pid=""
ios_dependency_seconds=$((SECONDS - ios_prepare_started))

if [[ "$ios_test_mode" == single ]]; then
  # Only the manual experiment delegates build, simulator startup and tests to Xcode.
  echo 'iOS starting single-process build and test'
  bash ios/scripts/ci-test.sh combined &
  ios_phase_pid=$!
  wait "$ios_phase_pid"
  ios_phase_pid=""
  exit 0
fi

echo "iOS starting build-for-testing"
bash ios/scripts/ci-test.sh compile &
ios_phase_pid=$!
wait "$ios_phase_pid"
ios_phase_pid=""

ios_boot_started=$SECONDS
python3 ios/scripts/preboot-simulator.py &
ios_preboot_pid=$!
wait "$ios_preboot_pid"
ios_preboot_pid=""
ios_boot_seconds=$((SECONDS - ios_boot_started))
echo "iOS simulator preparation: $ios_boot_seconds seconds"
echo "iOS total preparation: $((ios_dependency_seconds + ios_boot_seconds)) seconds"
echo "iOS startup before tests: $((SECONDS - ios_prepare_started)) seconds"

echo "iOS starting test-without-building"
bash ios/scripts/ci-test.sh run &
ios_phase_pid=$!
wait "$ios_phase_pid"
ios_phase_pid=""
