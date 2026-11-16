#!/usr/bin/env bash
# Default order resolves and compiles before booting the exact test simulator.
# Experimental ordering retains ownership of each phase and its descendants.
# Uses ci-test.sh's RUNNER_TEMP and IOS_TEST_DESTINATION contracts.
# IOS_CI_PARALLEL_SIMULATOR=true opts into the concurrent startup experiment.
# IOS_CI_BOOT_BEFORE_COMPILE=true starts the simulator before compilation.
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

prepare_simulator() {
  local ios_boot_started=$SECONDS
  python3 ios/scripts/preboot-simulator.py &
  ios_preboot_pid=$!
  wait "$ios_preboot_pid"
  ios_preboot_pid=""
  ios_boot_seconds=$((SECONDS - ios_boot_started))
  echo "iOS simulator preparation: $ios_boot_seconds seconds"
}

ios_prepare_started=$SECONDS
bash ios/scripts/ci-test.sh prepare &
ios_phase_pid=$!
wait "$ios_phase_pid"
ios_phase_pid=""
ios_dependency_seconds=$((SECONDS - ios_prepare_started))

if [[ "${IOS_CI_BOOT_BEFORE_COMPILE:-false}" == true ]]; then
  prepare_simulator
elif [[ "${IOS_CI_PARALLEL_SIMULATOR:-false}" == true ]]; then
  ios_parallel_started=$SECONDS
fi

echo "iOS starting build-for-testing"
bash ios/scripts/ci-test.sh compile &
ios_phase_pid=$!

if [[ "${IOS_CI_BOOT_BEFORE_COMPILE:-false}" != true && "${IOS_CI_PARALLEL_SIMULATOR:-false}" == true ]]; then
  (
    ios_boot_started=$SECONDS
    python3 ios/scripts/preboot-simulator.py
    echo "iOS simulator preparation: $((SECONDS - ios_boot_started)) seconds"
  ) &
  ios_preboot_pid=$!
fi

wait "$ios_phase_pid"
ios_phase_pid=""

if [[ "${IOS_CI_BOOT_BEFORE_COMPILE:-false}" == true ]]; then
  echo "iOS total preparation: $((ios_dependency_seconds + ios_boot_seconds)) seconds"
elif [[ "${IOS_CI_PARALLEL_SIMULATOR:-false}" == true ]]; then
  wait "$ios_preboot_pid"
  ios_preboot_pid=""
  echo "iOS parallel compilation and simulator: $((SECONDS - ios_parallel_started)) seconds"
else
  prepare_simulator
  echo "iOS total preparation: $((ios_dependency_seconds + ios_boot_seconds)) seconds"
fi
echo "iOS startup before tests: $((SECONDS - ios_prepare_started)) seconds"

echo "iOS starting test-without-building"
bash ios/scripts/ci-test.sh run &
ios_phase_pid=$!
wait "$ios_phase_pid"
ios_phase_pid=""
