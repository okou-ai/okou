#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_WORKER="${SCRIPT_DIR}/runner-behavior-drain-resume-remote.sh"
DURABLE_RUNNER="${SCRIPT_DIR}/runner-behavior-durable.sh"
REMOTE="${METAL_USER}@${HOST}"

echo "=== Generating config ==="
# shellcheck disable=SC2029
ssh "$REMOTE" "sudo ${BIN_DIR}/runner config \
  --profile vm0/default \
  --rootfs-hash ${DEFAULT_ROOTFS_HASH} \
  --snapshot-hash ${DEFAULT_SNAPSHOT_HASH} \
  --hostname ${HOST} \
  --group vm0/drain-${JOB_REF} \
  --runner-dirname ${JOB_REF}-drain \
  --max-concurrent 2 \
  --api-url https://not-a-real-server.test \
  --token vm0_official_${OFFICIAL_RUNNER_SECRET}"

exec "$DURABLE_RUNNER" drain-resume "$REMOTE_WORKER"
