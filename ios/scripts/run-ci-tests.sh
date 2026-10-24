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
ios_selection_file=""
cleanup() {
  local ios_child
  for ios_child in "$ios_preboot_pid" "$ios_phase_pid"; do
    if [[ -n "$ios_child" ]]; then
      kill -TERM -- "-$ios_child" 2>/dev/null || true
      wait "$ios_child" 2>/dev/null || true
    fi
  done
  if [[ -n "$ios_selection_file" ]]; then
    rm -f "$ios_selection_file"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ios_boot_mode=${IOS_SIMULATOR_BOOT_MODE:-preboot}
case "$ios_boot_mode" in
  preboot | xcodebuild) ;;
  *) echo "Unsupported simulator boot mode: $ios_boot_mode" >&2; exit 2 ;;
esac
echo "iOS simulator boot mode: $ios_boot_mode"

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
if [[ "$ios_boot_mode" == xcodebuild ]]; then
  ios_selection_file=$(mktemp "$RUNNER_TEMP/okou-ios-simulator.XXXXXX")
  python3 ios/scripts/preboot-simulator.py --select-only > "$ios_selection_file" &
else
  python3 ios/scripts/preboot-simulator.py &
fi
ios_preboot_pid=$!
wait "$ios_preboot_pid"
ios_preboot_pid=""
ios_boot_seconds=$((SECONDS - ios_boot_started))
if [[ "$ios_boot_mode" == xcodebuild ]]; then
  IFS= read -r ios_device_id < "$ios_selection_file"
  export IOS_TEST_DESTINATION="platform=iOS Simulator,id=$ios_device_id"
  echo "iOS simulator selection: $ios_boot_seconds seconds"
  echo "iOS test Xcode owns boot and readiness for $ios_device_id"
else
  echo "iOS simulator preparation: $ios_boot_seconds seconds"
fi
echo "iOS total preparation: $((ios_dependency_seconds + ios_boot_seconds)) seconds"
echo "iOS startup before tests: $((SECONDS - ios_prepare_started)) seconds"

echo "iOS starting test-without-building"
bash ios/scripts/ci-test.sh run &
ios_phase_pid=$!
wait "$ios_phase_pid"
ios_phase_pid=""
