#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_WORKER="${SCRIPT_DIR}/runner-behavior-systemd-reload-remote.sh"
DURABLE_RUNNER="${SCRIPT_DIR}/runner-behavior-durable.sh"
REMOTE="${METAL_USER}@${HOST}"
GROUP="vm0/systemd-reload-${JOB_REF}"

echo "=== Generating systemd reload test configs ==="
for SUFFIX in systemd-reload-a systemd-reload-b; do
  # shellcheck disable=SC2029
  ssh "$REMOTE" "sudo ${BIN_DIR}/runner config \
    --profile vm0/default \
    --rootfs-hash ${DEFAULT_ROOTFS_HASH} \
    --snapshot-hash ${DEFAULT_SNAPSHOT_HASH} \
    --hostname ${HOST} \
    --group ${GROUP} \
    --runner-dirname ${JOB_REF}-${SUFFIX} \
    --max-concurrent 1 \
    --api-url https://not-a-real-server.test \
    --token vm0_official_${OFFICIAL_RUNNER_SECRET}"
done

exec "$DURABLE_RUNNER" systemd-reload "$REMOTE_WORKER"
