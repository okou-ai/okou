#!/usr/bin/env bash
set -euo pipefail

: "${METAL_USER:?}"
: "${HOST:?}"
: "${JOB_REF:?}"
: "${DEFAULT_ROOTFS_HASH:?}"
: "${DEFAULT_SNAPSHOT_HASH:?}"
: "${TEST_BIN:?}"
: "${GITHUB_RUN_ID:?}"
: "${GITHUB_RUN_ATTEMPT:?}"

[[ "$JOB_REF" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]]
[[ "$GITHUB_RUN_ID" =~ ^[0-9]+$ && "$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+$ ]]
[[ "$DEFAULT_ROOTFS_HASH" =~ ^[0-9a-f]{64}$ && "$DEFAULT_SNAPSHOT_HASH" =~ ^[0-9a-f]{64}$ ]]
test -x "$TEST_BIN"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
FC_VERSION=$(sed -n 's/^pub const FIRECRACKER_VERSION: &str = "\([^"]*\)";$/\1/p' "$REPO_ROOT/crates/runner/src/deps.rs")
KERNEL_VERSION=$(sed -n 's/^pub const KERNEL_VERSION: &str = "\([^"]*\)";$/\1/p' "$REPO_ROOT/crates/runner/src/deps.rs")
[[ "$FC_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && "$KERNEL_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]

REMOTE="${METAL_USER}@${HOST}"
EXECUTION_KEY="${JOB_REF}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
REMOTE_BIN="/tmp/runner-guest-rpc-${EXECUTION_KEY}"
cleanup_upload() {
  ssh "$REMOTE" sudo rm -f -- "$REMOTE_BIN"
}
trap cleanup_upload EXIT
scp "$TEST_BIN" "${REMOTE}:${REMOTE_BIN}"

ssh "$REMOTE" sudo bash -s -- \
  "$REMOTE_BIN" "$EXECUTION_KEY" "$DEFAULT_ROOTFS_HASH" "$DEFAULT_SNAPSHOT_HASH" \
  "$FC_VERSION" "$KERNEL_VERSION" <<'REMOTE_SCRIPT'
set -euo pipefail
TEST_BIN=$1
EXECUTION_KEY=$2
ROOTFS_HASH=$3
SNAPSHOT_HASH=$4
FC_VERSION=$5
KERNEL_VERSION=$6
BASE_DIR="/var/lib/vm0-runner/guest-rpc-tests/${EXECUTION_KEY}"
UNIT="runner-guest-rpc-${EXECUTION_KEY}"
TEST_NAME=packaged_helper_completes_over_fresh_restored_and_reused_firecracker
PAYLOAD_TEST=packaged_runtime_executes_real_agents_tools_and_children
ROOTFS_DIR="/var/lib/vm0-runner/images/${ROOTFS_HASH}"
SNAPSHOT_DIR="${ROOTFS_DIR}/snapshots/${SNAPSHOT_HASH}"
FIRECRACKER="/var/lib/vm0-runner/firecracker/${FC_VERSION}/firecracker"
KERNEL="/var/lib/vm0-runner/firecracker/${FC_VERSION}/vmlinux-${KERNEL_VERSION}"

cleanup() {
  systemctl stop "${UNIT}.service" || true
  rm -f -- "$TEST_BIN"
  rm -rf -- "$BASE_DIR"
}
trap cleanup EXIT

# Pin both immutable image inputs against GC, in the production lock order.
exec 3>"/var/lib/vm0-runner/locks/rootfs-${ROOTFS_HASH}.lock"
flock --shared --timeout 60 3
exec 4>"/var/lib/vm0-runner/locks/snapshot-${SNAPSHOT_HASH}.lock"
flock --shared --timeout 60 4
for fixture in "$FIRECRACKER" "$KERNEL" "$ROOTFS_DIR/rootfs.ext4" "$ROOTFS_DIR/runtime.ext4" \
  "$SNAPSHOT_DIR/snapshot.bin" "$SNAPSHOT_DIR/memory.bin" "$SNAPSHOT_DIR/cow.img"; do
  test -s "$fixture"
done
"$TEST_BIN" --ignored --list | grep -Fx "${TEST_NAME}: test"
"$TEST_BIN" --ignored --list | grep -Fx "${PAYLOAD_TEST}: test"
mkdir -p "$BASE_DIR"
echo "RPC_FIRECRACKER_ARTIFACT rootfs=$ROOTFS_HASH snapshot=$SNAPSHOT_HASH firecracker=$FC_VERSION"
# The transient unit bounds the test and its children even if SSH disconnects.
systemd-run --wait --collect --pipe "--unit=${UNIT}" \
  --property=Type=exec --property=RuntimeMaxSec=480 --property=TimeoutStopSec=30 \
  "--setenv=OKOU_TEST_RPC_FIRECRACKER=${FIRECRACKER}" \
  "--setenv=OKOU_TEST_RPC_KERNEL=${KERNEL}" \
  "--setenv=OKOU_TEST_RPC_ROOTFS=${ROOTFS_DIR}/rootfs.ext4" \
  "--setenv=OKOU_TEST_RPC_RUNTIME=${ROOTFS_DIR}/runtime.ext4" \
  "--setenv=OKOU_TEST_RPC_SNAPSHOT_DIR=${SNAPSHOT_DIR}" \
  "--setenv=OKOU_TEST_RPC_SNAPSHOT_HASH=${SNAPSHOT_HASH}" \
  "--setenv=OKOU_TEST_RPC_BASE_DIR=${BASE_DIR}" \
  "$TEST_BIN" --ignored --exact "$TEST_NAME" "$PAYLOAD_TEST" --nocapture --test-threads=1
REMOTE_SCRIPT
