#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 2
  fi
}

output_value() {
  local key=$1 file=$2
  sed -n "s/^${key}=//p" "$file" | tail -n1
}

required_env=(
  AWS_METAL_RUNNER_HOSTS
  BIN_DIR
  JOB_REF
  METAL_HOSTS
  METAL_USER
  OFFICIAL_RUNNER_SECRET
  REPO
  ROOTFS_HASH_MAP
  RUNNER_API_URL
  RUNNER_DIR
  RUNNER_GROUP
  RUNNER_SERVICE_REF
  RUNNER_SHA_MAP
  SNAPSHOT_HASH_MAP
  VERCEL_BYPASS
)
for name in "${required_env[@]}"; do
  require_env "$name"
done

# Match the Crates Runner behavior lane's selection without replicating each
# CI namespace's idle and prewarmed pools across every metal host.
SELECTED_CONTEXT=$(AWS_METAL_RUNNER_HOSTS="$METAL_HOSTS" \
  "${SCRIPT_DIR}/runner-host-architecture-groups.sh" select-context "$JOB_REF")
SELECTED_HOST=$(jq -r '.host' <<<"$SELECTED_CONTEXT")
export SELECTED_HOST
echo "Selected runner service host: ${SELECTED_HOST}"

work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/runner-reconcile-start.XXXXXX")
export RUNNER_RECEIPT_FILE="${work_dir}/receipt.json"
trap 'rm -rf "$work_dir"' EXIT
check_output="${work_dir}/check.out"

GITHUB_OUTPUT="$check_output" \
  "${SCRIPT_DIR}/reconcile-runner-binary-groups.sh" check
recovery_needed=$(output_value recovery-needed "$check_output")
runner_host_groups_matrix=$(output_value runner-host-groups-matrix "$check_output")
if [ "$recovery_needed" != "true" ] && [ "$recovery_needed" != "false" ]; then
  echo "::error::Runner binary reconciliation returned an invalid recovery decision: ${recovery_needed}" >&2
  exit 2
fi

if [ "$recovery_needed" = "true" ]; then
  recovery_dir="${work_dir}/recovery"
  plan_output="${work_dir}/plan.out"
  GITHUB_OUTPUT="$plan_output" \
    RESOLVE_OUTPUT_DIR="${work_dir}/references" \
    RUNNER_HOST_GROUPS_MATRIX="$runner_host_groups_matrix" \
    "${SCRIPT_DIR}/runner-binary-cache-plan.sh"

  recovery_miss_count=$(output_value miss-count "$plan_output")
  if [ "$recovery_miss_count" != "0" ]; then
    echo "::error::Validated runner binary recovery was unavailable for ${recovery_miss_count} target(s)" >&2
    exit 1
  fi

  recovery_references=$(output_value hit-references "$plan_output")
  while IFS= read -r reference; do
    target=$(jq -r '.target' <<<"$reference")
    env GITHUB_OUTPUT= \
      EXPECTED_TARGET="$target" \
      EXPECTED_BINARY_INPUT_DIGEST="$(jq -r '.binaryInputDigest' <<<"$reference")" \
      CACHE_REFERENCE="$reference" \
      RESOLVE_OUTPUT_DIR="${recovery_dir}/${target}" \
      "${SCRIPT_DIR}/runner-binary-cache.sh" download-reference
  done < <(jq -c '.[]' <<<"$recovery_references")

  RECOVERY_DIR="$recovery_dir" \
    "${SCRIPT_DIR}/reconcile-runner-binary-groups.sh" restore
fi

read_host_capacity() {
  local HOST=$1
  local RUNNER_SERVICE_SUFFIX=$2
  local REMOTE="${METAL_USER}@${HOST}"
  # shellcheck disable=SC2029
  ssh "$REMOTE" "sudo ${BIN_DIR}/runner service wait-running --name ${RUNNER_SERVICE_SUFFIX} --timeout-secs 120"
}

reconcile_service_on_host() {
  set -euo pipefail

  local HOST=$1
  local HOST_INDEX=$2
  local RUNNER_SERVICE_SUFFIX="${RUNNER_SERVICE_REF}-${HOST_INDEX}"
  local RUNNER_DIRNAME="${RUNNER_DIR##*/}"
  local REMOTE="${METAL_USER}@${HOST}"
  local MC

  # Retire the current service namespace on every host, including staging:
  # its service names stay stable while image directories and selection change.
  # shellcheck disable=SC2029
  timeout 180s ssh "$REMOTE" "sudo ${BIN_DIR}/runner service stop --name '${RUNNER_SERVICE_SUFFIX}' --force --cleanup partial-start"
  if [ "$HOST" != "$SELECTED_HOST" ]; then
    echo "Retired unselected runner service ${RUNNER_SERVICE_SUFFIX} on ${HOST}"
    return
  fi

  echo "=== Starting runner service ${RUNNER_SERVICE_SUFFIX} on ${HOST} ==="

  local ROOTFS_HASH SNAPSHOT_HASH
  ROOTFS_HASH=$(echo "$ROOTFS_HASH_MAP" | jq -r --arg h "$HOST" '.[$h]')
  SNAPSHOT_HASH=$(echo "$SNAPSHOT_HASH_MAP" | jq -r --arg h "$HOST" '.[$h]')
  if [ -z "$ROOTFS_HASH" ] || [ "$ROOTFS_HASH" = "null" ] \
      || [ -z "$SNAPSHOT_HASH" ] || [ "$SNAPSHOT_HASH" = "null" ]; then
    echo "::error::No rootfs/snapshot hash found for ${HOST} in hash map"
    return 1
  fi

  # The outer lifecycle lock prevents closed-PR cleanup from deleting this
  # namespace between validated reconciliation and service readiness.
  # shellcheck disable=SC2029
  if ! ssh "$REMOTE" "test -x ${BIN_DIR}/runner"; then
    echo "::error::Runner binary disappeared on ${HOST} after validated reconciliation."
    return 1
  fi

  # shellcheck disable=SC2029
  ssh "$REMOTE" "sudo ${BIN_DIR}/runner config \
    --profile vm0/default \
    --rootfs-hash ${ROOTFS_HASH} \
    --snapshot-hash ${SNAPSHOT_HASH} \
    --hostname ${HOST} \
    --group ${RUNNER_GROUP} \
    --runner-dirname ${RUNNER_DIRNAME} \
    --concurrency-factor 1.5 \
    --api-url ${RUNNER_API_URL} \
    --token vm0_official_${OFFICIAL_RUNNER_SECRET}"

  # shellcheck disable=SC2029
  ssh "$REMOTE" "sudo rm -f ${RUNNER_DIR}/status.json"

  # shellcheck disable=SC2029
  ssh "$REMOTE" "sudo ${BIN_DIR}/runner service start \
    --name ${RUNNER_SERVICE_SUFFIX} \
    --config ${RUNNER_DIR}/runner.yaml \
    --env VERCEL_AUTOMATION_BYPASS_SECRET=${VERCEL_BYPASS} \
    --env USE_MOCK_CLAUDE=true \
    --env USE_MOCK_CODEX=true"

  if ! MC=$(read_host_capacity "$HOST" "$RUNNER_SERVICE_SUFFIX"); then
    return 1
  fi
  echo "Runner ready on ${HOST}: max_concurrent=${MC}"
  # shellcheck disable=SC2029
  ssh "$REMOTE" "sudo ${BIN_DIR}/runner doctor --name ${RUNNER_SERVICE_SUFFIX}"

  # Capture the deployed generation while the caller still owns its lifecycle
  # lock. Cleanup must not discover a replacement generation later.
  local IDENTITY
  IDENTITY=$(ssh "$REMOTE" bash -s -- "$RUNNER_DIR" <<'REMOTE_SCRIPT'
set -euo pipefail
runner_id=$(sudo cat "$1/runner_id")
generation=$(sudo cat "$1/heartbeat_generation")
[[ "$runner_id" =~ ^[0-9a-f-]{36}$ && "$generation" =~ ^[1-9][0-9]*$ ]]
printf '{"runnerId":"%s","heartbeatGeneration":%s}\n' "$runner_id" "$generation"
REMOTE_SCRIPT
  )
  jq -ce --arg host "$HOST" --arg service "$RUNNER_SERVICE_SUFFIX" --arg binDir "$BIN_DIR" '
    select((.runnerId | type == "string" and test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")) and
      (.heartbeatGeneration | type == "number" and . > 0 and . <= 9007199254740991 and . == floor)) |
    . + {host: $host, service: $service, binDir: $binDir}
  ' <<<"$IDENTITY" >"$RUNNER_RECEIPT_FILE"
  echo "=== Runner started on ${HOST} ==="
}

LOG_DIR=$(mktemp -d)
HOSTS=()
PIDS=()
PGIDS=()
RUNNER_START_SUCCEEDED=0
RUNNER_START_SIGNAL_EXIT=0
RUNNER_START_RECORDING=0

cleanup_logs() {
  rm -rf "$LOG_DIR" "$work_dir"
}

request_runner_start_exit() {
  RUNNER_START_SIGNAL_EXIT=$1
  if [ "$RUNNER_START_RECORDING" -ne 1 ]; then
    exit "$RUNNER_START_SIGNAL_EXIT"
  fi
}

check_runner_start_exit() {
  if [ "$RUNNER_START_SIGNAL_EXIT" -ne 0 ]; then
    exit "$RUNNER_START_SIGNAL_EXIT"
  fi
}

process_group_for_pid() {
  local PID=$1
  ps -o pgid= -p "$PID" 2>/dev/null | tr -d ' '
}

stop_background_start_jobs() {
  local JOB_PIDS=()
  local START_PGIDS=()
  local WAIT_PIDS=()
  local CURRENT_PGID
  CURRENT_PGID=$(process_group_for_pid "$$" || true)
  for PGID in "${PGIDS[@]}"; do
    if [[ "$PGID" =~ ^[0-9]+$ && "$PGID" != "$CURRENT_PGID" ]]; then
      START_PGIDS+=("$PGID")
    fi
  done
  for PID in $(jobs -pr); do
    JOB_PIDS+=("$PID")
    WAIT_PIDS+=("$PID")
  done
  for PID in "${PIDS[@]}"; do
    WAIT_PIDS+=("$PID")
  done
  for PID in "${JOB_PIDS[@]}"; do
    local PGID
    PGID=$(process_group_for_pid "$PID" || true)
    if [[ "$PGID" =~ ^[0-9]+$ && "$PGID" != "$CURRENT_PGID" ]]; then
      START_PGIDS+=("$PGID")
    else
      kill -TERM "$PID" 2>/dev/null || true
    fi
  done
  for PGID in "${START_PGIDS[@]}"; do
    kill -TERM -- "-$PGID" 2>/dev/null || true
  done
  for PGID in "${START_PGIDS[@]}"; do
    kill -KILL -- "-$PGID" 2>/dev/null || true
  done
  for PID in "${JOB_PIDS[@]}"; do
    kill -KILL "$PID" 2>/dev/null || true
  done
  for PID in "${WAIT_PIDS[@]}"; do
    wait "$PID" 2>/dev/null || true
  done
}

stop_started_hosts() {
  local STOP_PIDS=()
  local HOST_INDEX=0
  for HOST in $(echo "$METAL_HOSTS" | tr ',' ' '); do
    HOST_INDEX=$((HOST_INDEX + 1))
    [ "$HOST" = "$SELECTED_HOST" ] || continue
    local RUNNER_SERVICE_SUFFIX="${RUNNER_SERVICE_REF}-${HOST_INDEX}"
    local REMOTE="${METAL_USER}@${HOST}"
    echo "::warning::Requesting stop for partially started runner service ${RUNNER_SERVICE_SUFFIX} on ${HOST}"
    (
      # shellcheck disable=SC2029
      timeout 180s ssh "$REMOTE" "sudo ${BIN_DIR}/runner service stop --name '${RUNNER_SERVICE_SUFFIX}' --force --cleanup partial-start" >/dev/null || true
    ) &
    STOP_PIDS+=($!)
  done
  for PID in "${STOP_PIDS[@]}"; do
    wait "$PID" 2>/dev/null || true
  done
}

cleanup_runner_start() {
  local EXIT_CODE=$?
  trap - EXIT
  trap '' INT TERM
  if [ "$RUNNER_START_SUCCEEDED" -ne 1 ]; then
    stop_background_start_jobs
    stop_started_hosts
  fi
  cleanup_logs
  exit "$EXIT_CODE"
}

trap cleanup_runner_start EXIT
trap 'request_runner_start_exit 130' INT
trap 'request_runner_start_exit 143' TERM
export -f read_host_capacity reconcile_service_on_host
HOST_INDEX=0
for HOST in $(echo "$METAL_HOSTS" | tr ',' ' '); do
  HOST_INDEX=$((HOST_INDEX + 1))
  # Retain the original inventory index so reruns replace the existing service.
  HOSTS+=("$HOST")
  RUNNER_START_RECORDING=1
  setsid bash -c 'reconcile_service_on_host "$@"' reconcile_service_on_host "$HOST" "$HOST_INDEX" >"${LOG_DIR}/${HOST}.log" 2>&1 &
  PIDS+=($!)
  PGIDS+=($!)
  RUNNER_START_RECORDING=0
  check_runner_start_exit
done

FAILED=0
for i in "${!PIDS[@]}"; do
  if ! wait "${PIDS[$i]}"; then
    check_runner_start_exit
    FAILED=1
    echo "::error::Runner service reconciliation failed on ${HOSTS[$i]}"
  fi
  check_runner_start_exit
  echo "=== ${HOSTS[$i]} ==="
  cat "${LOG_DIR}/${HOSTS[$i]}.log"
  check_runner_start_exit
done
rm -rf "$LOG_DIR"
if [ "$FAILED" -ne 0 ]; then
  exit 1
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  receipt=$(jq -ce . "$RUNNER_RECEIPT_FILE")
  printf 'runner-receipt=%s\n' "$receipt" >>"$GITHUB_OUTPUT"
fi
RUNNER_START_SUCCEEDED=1
