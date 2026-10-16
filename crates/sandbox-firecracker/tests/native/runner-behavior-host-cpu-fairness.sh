#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${METAL_USER:?METAL_USER is required}"
: "${HOST:?HOST is required}"
: "${JOB_REF:?JOB_REF is required}"
: "${DEFAULT_ROOTFS_HASH:?DEFAULT_ROOTFS_HASH is required}"
: "${TEST_BIN:?TEST_BIN is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required}"

HOST_CPU_TEST_MODE=${HOST_CPU_TEST_MODE:-placement}
case "$HOST_CPU_TEST_MODE" in
  placement|measurement) ;;
  *)
    echo "HOST_CPU_TEST_MODE must be placement or measurement" >&2
    exit 2
    ;;
esac

case "$JOB_REF" in
  ''|*[!a-zA-Z0-9._-]*)
    echo "JOB_REF contains unsupported characters" >&2
    exit 2
    ;;
esac
case "$GITHUB_RUN_ID:$GITHUB_RUN_ATTEMPT" in
  *[!0-9:]*|:*|*:)
    echo "GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must be numeric" >&2
    exit 2
    ;;
esac
if [ ! -x "$TEST_BIN" ]; then
  echo "host CPU fairness test binary is not executable: $TEST_BIN" >&2
  exit 2
fi
if [[ ! "$DEFAULT_ROOTFS_HASH" =~ ^[0-9a-f]{64}$ ]]; then
  echo "DEFAULT_ROOTFS_HASH must be a lowercase SHA-256 hash" >&2
  exit 2
fi

REMOTE="${METAL_USER}@${HOST}"
EXECUTION_KEY="${JOB_REF}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
REMOTE_BIN="/tmp/runner-host-cpu-fairness-${EXECUTION_KEY}"

cleanup_remote_binary() {
  ssh "$REMOTE" bash -s -- "$REMOTE_BIN" 2>/dev/null <<'REMOTE_CLEANUP' || true
set -euo pipefail
rm -f -- "$1"
REMOTE_CLEANUP
}
trap cleanup_remote_binary EXIT

scp "$TEST_BIN" "${REMOTE}:${REMOTE_BIN}"

# The durable worker receives the full run/attempt key as its job reference.
BIN_DIR=/tmp JOB_REF="$EXECUTION_KEY" \
  "${SCRIPT_DIR}/../../../runner/tests/behavior/runner-behavior-durable.sh" host-cpu-fairness \
  "${SCRIPT_DIR}/runner-behavior-host-cpu-fairness-remote.sh" "$DEFAULT_ROOTFS_HASH" "$HOST_CPU_TEST_MODE"
