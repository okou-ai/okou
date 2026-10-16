#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_WORKER="${SCRIPT_DIR}/runner-behavior-keep-alive-remote.sh"
DURABLE_RUNNER="${SCRIPT_DIR}/runner-behavior-durable.sh"
REMOTE="${METAL_USER}@${HOST}"
SVC="${JOB_REF}-keepalive"
GROUP="vm0/keepalive-${JOB_REF}"
RUNNER_DIR="/var/lib/vm0-runner/runners/${SVC}"
GROUP_DIR="/var/lib/vm0-runner/groups/vm0/keepalive-${JOB_REF}"

echo "=== Cleaning stale keep-alive runner state ==="
ssh "$REMOTE" bash -s -- "${BIN_DIR}" "${SVC}" "${GROUP_DIR}" "${RUNNER_DIR}" <<'REMOTE_SCRIPT'
set -euo pipefail
BIN_DIR=$1; SVC=$2; GROUP_DIR=$3; RUNNER_DIR=$4
UNIT="vm0-runner-${SVC}.service"
# A failed stop may still leave a stopped/collected unit; require positive state.
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force || true
INACTIVE=false
for _ in $(seq 1 30); do
  if ACTIVE_STATE=$(sudo systemctl show "$UNIT" --property=ActiveState --value); then
    case "$ACTIVE_STATE" in
      inactive | failed)
        INACTIVE=true
        break
        ;;
    esac
  fi
  sleep 1
done
if [ "$INACTIVE" != true ]; then
  echo "FAIL: ${UNIT} inactivity was not confirmed after cleanup stop; preserving state" >&2
  exit 1
fi
sudo rm -rf "$GROUP_DIR" "$RUNNER_DIR"
REMOTE_SCRIPT

echo "=== Generating config ==="
# shellcheck disable=SC2029
ssh "$REMOTE" "sudo ${BIN_DIR}/runner config \
  --profile vm0/default \
  --rootfs-hash ${DEFAULT_ROOTFS_HASH} \
  --snapshot-hash ${DEFAULT_SNAPSHOT_HASH} \
  --hostname ${HOST} \
  --group ${GROUP} \
  --runner-dirname ${SVC} \
  --max-concurrent 2 \
  --api-url https://not-a-real-server.test \
  --token vm0_official_${OFFICIAL_RUNNER_SECRET}"

exec "$DURABLE_RUNNER" keep-alive "$REMOTE_WORKER"
