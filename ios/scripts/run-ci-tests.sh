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

ios_prepare_started=$SECONDS
bash ios/scripts/ci-test.sh prepare &
ios_phase_pid=$!
wait "$ios_phase_pid"
ios_phase_pid=""
ios_dependency_seconds=$((SECONDS - ios_prepare_started))

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
