#!/usr/bin/env bash
# Start the receiver before the simulator fills the runner's CPU. The owned
# process groups let cancellation and preparation failures stop both children.
set -euo pipefail
set -m

receiver_pid=""
boot_pid=""
cleanup() {
  local pid
  for pid in "$receiver_pid" "$boot_pid"; do
    if [[ -n "$pid" ]]; then
      kill -TERM -- "-$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

python3 ios/scripts/wait-ci-test-artifact.py products --download-dir "$RUNNER_TEMP/ios-native-products" &
receiver_pid=$!
started=$SECONDS
python3 ios/scripts/preboot-simulator.py &
boot_pid=$!
wait "$boot_pid"
boot_pid=""
echo "iOS simulator preparation: $((SECONDS - started)) seconds"
wait "$receiver_pid"
receiver_pid=""
