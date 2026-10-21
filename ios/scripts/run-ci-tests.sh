#!/usr/bin/env bash
# Resolve dependencies while the exact simulator becomes ready, then compile.
# Keep cold system startup ahead of asset-tool discovery during compilation.
# Uses ci-test.sh's RUNNER_TEMP and IOS_TEST_DESTINATION contracts.
set -euo pipefail
ios_test_phase=${1:-all}
if [[ $# -gt 1 || ( "$ios_test_phase" != all && "$ios_test_phase" != prepare ) ]]; then
  echo "usage: run-ci-tests.sh [all|prepare]" >&2
  exit 2
fi
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

ios_preparation_started=$SECONDS
python3 ios/scripts/preboot-simulator.py &
ios_preboot_pid=$!
bash ios/scripts/ci-test.sh prepare &
ios_phase_pid=$!
wait "$ios_phase_pid"
ios_phase_pid=""
wait "$ios_preboot_pid"
ios_preboot_pid=""
echo "iOS combined preparation: $((SECONDS - ios_preparation_started)) seconds"

if [[ "$ios_test_phase" == prepare ]]; then
  exit 0
fi

bash ios/scripts/ci-test.sh compile &
ios_phase_pid=$!
wait "$ios_phase_pid"
ios_phase_pid=""

bash ios/scripts/ci-test.sh run &
ios_phase_pid=$!
wait "$ios_phase_pid"
ios_phase_pid=""
