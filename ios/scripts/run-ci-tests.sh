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
ios_fresh_device_file=""
cleanup() {
  local ios_child
  for ios_child in "$ios_preboot_pid" "$ios_phase_pid"; do
    if [[ -n "$ios_child" ]]; then
      kill -TERM -- "-$ios_child" 2>/dev/null || true
      wait "$ios_child" 2>/dev/null || true
    fi
  done
  if [[ -n "$ios_fresh_device_file" && -f "$ios_fresh_device_file" ]]; then
    local ios_fresh_udid
    ios_fresh_udid=$(python3 - "$ios_fresh_device_file" <<'PY'
import json, sys, uuid
record = json.load(open(sys.argv[1]))
assert record['udid'] != record['source_udid']
print(str(uuid.UUID(record['udid'])).upper())
PY
    )
    xcrun simctl shutdown "$ios_fresh_udid" 2>/dev/null || true
    if ! xcrun simctl delete "$ios_fresh_udid"; then
      echo "Fresh simulator cleanup failed for $ios_fresh_udid" >&2
    fi
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ios_process_mode=${IOS_TEST_PROCESS_MODE:-split}
case "$ios_process_mode" in
  split) ;;
  chained)
    if [[ "${GITHUB_EVENT_NAME:-}" != workflow_dispatch || "${IOS_REPEAT_TEST_STARTUP:-false}" == true ]]; then
      echo 'Chained test actions require a manual run without startup repetition' >&2
      exit 2
    fi
    ;;
  *) echo "Unknown iOS test process mode: $ios_process_mode" >&2; exit 2 ;;
esac
echo "iOS test process mode: $ios_process_mode"
ios_repeat_startup=${IOS_REPEAT_TEST_STARTUP:-false}
if [[ "${IOS_FRESH_SIMULATOR_PROBE:-false}" == true ]]; then
  if [[ "$ios_repeat_startup" != true ]]; then
    echo 'Fresh simulator comparison requires startup repetition' >&2
    exit 2
  fi
  if [[ -e "$RUNNER_TEMP/okou-ios-ci/fresh-device.json" ]]; then
    echo 'Fresh simulator comparison requires a new identity record' >&2
    exit 2
  fi
  ios_fresh_device_file="$RUNNER_TEMP/okou-ios-ci/fresh-device.json"
fi
if [[ "$ios_repeat_startup" == true ]]; then
  if [[ "${GITHUB_EVENT_NAME:-}" != workflow_dispatch || "${IOS_XCODE_STARTUP_SAMPLING:-false}" == true ]]; then
    echo 'Startup repetition requires a manual run with stack sampling disabled' >&2
    exit 2
  fi
  if [[ -e "$RUNNER_TEMP/okou-ios-ci/ColdTests.xcresult" ]]; then
    echo 'Startup repetition requires a new result directory' >&2
    exit 2
  fi
fi

ios_prepare_started=$SECONDS
bash ios/scripts/ci-test.sh prepare &
ios_phase_pid=$!
wait "$ios_phase_pid"
ios_phase_pid=""
ios_dependency_seconds=$((SECONDS - ios_prepare_started))

if [[ "$ios_process_mode" == chained ]]; then
  echo 'iOS starting chained build-for-testing and test-without-building'
  bash ios/scripts/ci-test.sh chained &
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

if [[ "$ios_repeat_startup" == true ]]; then
  echo 'iOS test startup round: cold'
  shasum -a 256 "$RUNNER_TEMP/okou-ios-ci/DerivedData/Build/Products/"*.xctestrun
fi
echo "iOS starting test-without-building"
bash ios/scripts/ci-test.sh run &
ios_phase_pid=$!
wait "$ios_phase_pid"
ios_phase_pid=""

if [[ "$ios_repeat_startup" == true ]]; then
  # A failed first suite exits above. This is a second full measurement, not a retry.
  mv "$RUNNER_TEMP/okou-ios-ci/Tests.xcresult" "$RUNNER_TEMP/okou-ios-ci/ColdTests.xcresult"
  ios_repeat_label=warm
  if [[ "${IOS_FRESH_SIMULATOR_PROBE:-false}" == true ]]; then
    ios_fresh_started=$SECONDS
    python3 ops/ios-fresh-simulator-probe.py &
    ios_preboot_pid=$!
    wait "$ios_preboot_pid"
    ios_preboot_pid=""
    IOS_TEST_DESTINATION=$(python3 - "$ios_fresh_device_file" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))['destination'])
PY
    )
    export IOS_TEST_DESTINATION
    echo "iOS fresh simulator preparation: $((SECONDS - ios_fresh_started)) seconds"
    ios_repeat_label=fresh
  fi
  echo "iOS test startup round: $ios_repeat_label"
  shasum -a 256 "$RUNNER_TEMP/okou-ios-ci/DerivedData/Build/Products/"*.xctestrun
  echo "iOS starting test-without-building"
  bash ios/scripts/ci-test.sh run &
  ios_phase_pid=$!
  wait "$ios_phase_pid"
  ios_phase_pid=""
fi
