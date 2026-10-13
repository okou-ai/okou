#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_READY_BENCHMARK_SOURCE="${SCRIPT_DIR}/runner-behavior-agent-ready-benchmark-remote.sh"
REMOTE_WORKER="${SCRIPT_DIR}/runner-behavior-process-containment-remote.sh"
DURABLE_RUNNER="${SCRIPT_DIR}/runner-behavior-durable.sh"
REMOTE="${METAL_USER}@${HOST}"
SVC="${JOB_REF}-process-containment"
GROUP="vm0/process-containment-${JOB_REF}"
RUNNER_DIR="/var/lib/vm0-runner/runners/${SVC}"
GROUP_DIR="/var/lib/vm0-runner/groups/vm0/process-containment-${JOB_REF}"
AGENT_READY_BENCHMARK_WORKER="${RUNNER_DIR}/agent-ready-benchmark.sh"
AGENT_READY_BENCHMARK_SHA256=$(sha256sum "$AGENT_READY_BENCHMARK_SOURCE" | awk '{print $1}')
SSH_ATTEMPTS=3

echo "=== Cleaning stale process-containment runner state ==="
ssh "$REMOTE" bash -s -- "${BIN_DIR}" "${SVC}" "${GROUP_DIR}" "${RUNNER_DIR}" <<'REMOTE_SCRIPT'
set -euo pipefail
BIN_DIR=$1; SVC=$2; GROUP_DIR=$3; RUNNER_DIR=$4
UNIT="vm0-runner-${SVC}.service"
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force || true
for _ in $(seq 1 30); do
  if ! sudo systemctl is-active --quiet "$UNIT"; then
    break
  fi
  sleep 1
done
if sudo systemctl is-active --quiet "$UNIT"; then
  echo "FAIL: ${UNIT} is still active after cleanup stop" >&2
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
  --max-concurrent 1 \
  --api-url https://not-a-real-server.test \
  --token vm0_official_${OFFICIAL_RUNNER_SECRET}"

stage_agent_ready_benchmark() {
  local attempt
  local status

  for attempt in $(seq 1 "$SSH_ATTEMPTS"); do
    status=0
    # The destination is derived from the workflow-owned job reference.
    # shellcheck disable=SC2029
    ssh "$REMOTE" "set -eu
destination='${AGENT_READY_BENCHMARK_WORKER}'
expected_sha256='${AGENT_READY_BENCHMARK_SHA256}'
source_tmp=\$(mktemp)
published_tmp=''
cleanup() {
  rm -f -- \"\$source_tmp\"
  if [ -n \"\$published_tmp\" ]; then
    sudo rm -f -- \"\$published_tmp\"
  fi
}
trap cleanup EXIT
cat > \"\$source_tmp\"
actual_sha256=\$(sha256sum \"\$source_tmp\" | awk '{print \$1}')
if [ \"\$actual_sha256\" != \"\$expected_sha256\" ]; then
  echo \"Agent-ready benchmark worker checksum mismatch\" >&2
  exit 1
fi
published_tmp=\$(sudo mktemp \"\${destination}.XXXXXX\")
sudo install -m 0755 \"\$source_tmp\" \"\$published_tmp\"
sudo mv -- \"\$published_tmp\" \"\$destination\"
published_tmp=''
" < "$AGENT_READY_BENCHMARK_SOURCE" || status=$?

    if [ "$status" -eq 0 ]; then
      return 0
    fi
    if [ "$status" -ne 255 ] || [ "$attempt" -eq "$SSH_ATTEMPTS" ]; then
      return "$status"
    fi

    echo "Transient SSH failure while staging Agent-ready benchmark worker; retrying (${attempt}/${SSH_ATTEMPTS})" >&2
    sleep "$attempt"
  done
}

echo "=== Staging Agent-ready benchmark worker ==="
stage_agent_ready_benchmark

exec "$DURABLE_RUNNER" process-containment "$REMOTE_WORKER" \
  "${AGENT_READY_BENCHMARK_SAMPLES:-1}"
