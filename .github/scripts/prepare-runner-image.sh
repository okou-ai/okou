#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "${SCRIPT_DIR}/runner-image-target.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 2
  fi
}

require_env JOB_REF
require_env HEAD_SHA
require_env METAL_HOSTS
require_env METAL_USER
job_ref=${JOB_REF:-}
head_sha=${HEAD_SHA:-}

TARGET_TRIPLE="${TARGET_TRIPLE-aarch64-unknown-linux-musl}"
PROFILE="${PROFILE:-vm0/default}"
MANIFEST_PATH="${MANIFEST_PATH:-runner-image-manifest/manifest.json}"
BIN_DIR="/var/lib/vm0-runner/bin/${job_ref}"
RUNNER_DIR="/var/lib/vm0-runner/runners/${job_ref}"
DERIVED_EXPECTED_REMOTE_ARCH=$(runner_image_expected_uname_m "$TARGET_TRIPLE")
if [ "${EXPECTED_REMOTE_ARCH+x}" = "x" ]; then
  if [ -z "$EXPECTED_REMOTE_ARCH" ]; then
    echo "EXPECTED_REMOTE_ARCH is empty" >&2
    exit 2
  fi
else
  EXPECTED_REMOTE_ARCH="$DERIVED_EXPECTED_REMOTE_ARCH"
fi
if [ "$EXPECTED_REMOTE_ARCH" != "$DERIVED_EXPECTED_REMOTE_ARCH" ]; then
  echo "EXPECTED_REMOTE_ARCH mismatch: ${TARGET_TRIPLE} maps to ${DERIVED_EXPECTED_REMOTE_ARCH}, got ${EXPECTED_REMOTE_ARCH}" >&2
  exit 2
fi

mapfile -t HOSTS < <(printf '%s\n' "$METAL_HOSTS" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep .)
if [ "${#HOSTS[@]}" -lt 1 ]; then
  echo "METAL_HOSTS is empty" >&2
  exit 1
fi
declare -A seen_hosts=()
for host in "${HOSTS[@]}"; do
  if [[ ! "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$ ]]; then
    echo "invalid METAL_HOSTS entry: ${host}" >&2
    exit 2
  fi
  host_key=${host,,}
  if [ -n "${seen_hosts[$host_key]+x}" ]; then
    echo "duplicate METAL_HOSTS entry: ${host}" >&2
    exit 2
  fi
  seen_hosts[$host_key]=1
done

mkdir -p "$(dirname "$MANIFEST_PATH")"

require_env RUNNER_PATH
require_env FRESH_METADATA_PATH
require_env EXPECTED_BINARY_INPUT_DIGEST
if [[ "$RUNNER_PATH" != /* ]]; then
  RUNNER_PATH="${REPO_ROOT}/${RUNNER_PATH}"
fi
if [[ "$FRESH_METADATA_PATH" != /* ]]; then
  FRESH_METADATA_PATH="${REPO_ROOT}/${FRESH_METADATA_PATH}"
fi
FRESH_METADATA_PATH="$FRESH_METADATA_PATH" \
RUNNER_PATH="$RUNNER_PATH" \
EXPECTED_TARGET="$TARGET_TRIPLE" \
EXPECTED_BINARY_INPUT_DIGEST="$EXPECTED_BINARY_INPUT_DIGEST" \
  "${SCRIPT_DIR}/runner-binary-cache.sh" fresh-validate >/dev/null

runner_sha=$(jq -r '.runnerSha256' "$FRESH_METADATA_PATH")
runner_size=$(jq -r '.runnerSizeBytes' "$FRESH_METADATA_PATH")
guest_sha_json=$(jq -c '.guestSha256' "$FRESH_METADATA_PATH")

# Optional versioned Okou CLI artifact (package.tgz + manifest.json) installed
# into the rootfs by `runner build --okou-cli-artifact`. Without it the image
# keeps the legacy commit-addressed `npx` launch path only.
OKOU_CLI_DIR="${BIN_DIR}/okou-cli"
okou_cli_json='null'
okou_cli_package_sha=""
if [ -n "${OKOU_CLI_ARTIFACT_DIR:-}" ]; then
  if [[ "$OKOU_CLI_ARTIFACT_DIR" != /* ]]; then
    OKOU_CLI_ARTIFACT_DIR="${REPO_ROOT}/${OKOU_CLI_ARTIFACT_DIR}"
  fi
  for artifact_file in package.tgz manifest.json; do
    if [ ! -f "${OKOU_CLI_ARTIFACT_DIR}/${artifact_file}" ]; then
      echo "Okou CLI artifact is missing ${artifact_file}: ${OKOU_CLI_ARTIFACT_DIR}" >&2
      exit 2
    fi
  done
  okou_cli_package_sha=$(sha256sum "${OKOU_CLI_ARTIFACT_DIR}/package.tgz" | awk '{print $1}')
  okou_cli_manifest_sha=$(jq -r '.package.sha256 // empty' "${OKOU_CLI_ARTIFACT_DIR}/manifest.json")
  if [ "$okou_cli_package_sha" != "$okou_cli_manifest_sha" ]; then
    echo "Okou CLI package sha mismatch: ${okou_cli_package_sha} != ${okou_cli_manifest_sha}" >&2
    exit 2
  fi
  okou_cli_json=$(jq -c '{
      cliVersion: .versions.cli,
      piAgentRuntimeVersion: .versions.piAgentRuntime,
      piSdkVersion: .versions.piSdk,
      packageSha256: .package.sha256
    }' "${OKOU_CLI_ARTIFACT_DIR}/manifest.json")
  if [ "$(jq -r '.cliVersion // empty' <<<"$okou_cli_json")" = "" ]; then
    echo "Okou CLI manifest has no versions.cli: ${OKOU_CLI_ARTIFACT_DIR}/manifest.json" >&2
    exit 2
  fi
fi

prepare_host() {
  local host=$1
  local host_index=$2
  local remote="${METAL_USER}@${host}"
  echo "=== Preparing ${host} (job: ${job_ref}) ==="

  local remote_arch
  if ! remote_arch=$(ssh "$remote" uname -m); then
    return 1
  fi
  remote_arch=$(printf '%s\n' "$remote_arch" | tail -n1 | tr -d '\r')
  if [ "$remote_arch" != "$EXPECTED_REMOTE_ARCH" ]; then
    echo "runner target ${TARGET_TRIPLE} expects remote architecture ${EXPECTED_REMOTE_ARCH}, but ${host} reported ${remote_arch}" >&2
    return 1
  fi

  if ! ssh "$remote" bash -s -- "${BIN_DIR}" "${RUNNER_DIR}" "${job_ref}" <<'REMOTE_SCRIPT'
set -euo pipefail
BIN_DIR=$1
RUNNER_DIR=$2
JOB_REF=$3
UNIT_PREFIX="vm0-runner-${JOB_REF}-"

declare -a PRIMARY_UNITS=()
discover_primary_units() {
  local output line unit load_state active_state sub_state description suffix
  if ! output=$(sudo systemctl list-units \
    --all --full --no-legend --plain "${UNIT_PREFIX}*.service" 2>&1); then
    printf '%s\n' "$output" >&2
    return 1
  fi

  PRIMARY_UNITS=()
  while IFS= read -r line; do
    read -r unit load_state active_state sub_state description <<< "$line"
    [ -n "$unit" ] || continue
    case "$unit" in
      "${UNIT_PREFIX}"*.service)
        suffix=${unit#"${UNIT_PREFIX}"}
        suffix=${suffix%.service}
        if [[ "$suffix" =~ ^[0-9]+$ ]]; then
          if [ "$load_state" != "loaded" ]; then
            continue
          fi
          if [ -z "$active_state" ] || [ -z "$sub_state" ]; then
            echo "malformed loaded runner service row: ${line}" >&2
            return 1
          fi
          PRIMARY_UNITS+=("$unit")
        fi
        ;;
    esac
  done <<< "$output"
}

# This CI cleanup is intentionally forceful. Avoid executing the existing
# runner binary here: a cancelled prior prepare can leave a truncated binary at
# the final path.
discover_primary_units
STOPPED_UNITS=("${PRIMARY_UNITS[@]}")
if [ "${#STOPPED_UNITS[@]}" -gt 0 ]; then
  sudo systemctl stop "${STOPPED_UNITS[@]}"
fi

discover_primary_units
for unit in "${PRIMARY_UNITS[@]}"; do
  if ! state=$(sudo systemctl show \
    --property=ActiveState --value "$unit" 2>&1); then
    printf '%s\n' "$state" >&2
    exit 1
  fi
  case "$state" in
    inactive|failed) ;;
    *)
      echo "runner service ${unit} is ${state} after stop" >&2
      exit 1
      ;;
  esac
done

if [ "${#STOPPED_UNITS[@]}" -gt 0 ]; then
  sudo systemctl reset-failed "${STOPPED_UNITS[@]}" 2>/dev/null || true
fi

sudo rm -rf "${BIN_DIR}" "${RUNNER_DIR}"
sudo mkdir -p "${BIN_DIR}"
case "$BIN_DIR" in
  /var/lib/vm0-runner/bin/staging-*)
    sudo find /var/lib/vm0-runner/bin \
      -mindepth 1 -maxdepth 1 -type d \
      -name 'staging-*' ! -path "$BIN_DIR" -mtime +2 \
      -exec rm -rf {} +
    ;;
esac
REMOTE_SCRIPT
  then
    return 1
  fi

  local tmp_runner upload_attempt upload_status upload_started upload_elapsed
  local tmp_template="${BIN_DIR}/runner.${head_sha}.${host_index}.tmp.XXXXXX"
  for upload_attempt in 1 2; do
    # A failed SSH client can leave a remote writer alive. Never let a retry
    # share its candidate with that writer; existing job-directory cleanup owns
    # abandoned candidates, which are never eligible for publication.
    if tmp_runner=$(ssh "$remote" bash -s -- "$tmp_template" <<'REMOTE_SCRIPT'
set -euo pipefail
sudo mktemp "$1"
REMOTE_SCRIPT
    ); then
      :
    else
      upload_status=$?
      echo "runner upload candidate allocation failed: host=${host} attempt=${upload_attempt}/2 status=${upload_status}" >&2
      return "$upload_status"
    fi

    upload_started=$SECONDS
    echo "runner upload started: host=${host} attempt=${upload_attempt}/2 expected_bytes=${runner_size} candidate=${tmp_runner}"
    # Bound only the binary stream (not GC/build or global SSH behavior). Two
    # stalled uploads still fit within the unchanged 20-minute image job budget.
    # Reopen stdin on every attempt so the successful candidate gets all bytes.
    if OKOU_CLOUDFLARE_SSH_OPERATION_TIMEOUT_SECONDS=120 \
      ssh "$remote" sudo install -m 755 /dev/stdin "${tmp_runner}" < "$RUNNER_PATH"; then
      echo "runner upload completed: host=${host} attempt=${upload_attempt}/2 elapsed_seconds=$((SECONDS - upload_started))"
      break
    else
      upload_status=$?
    fi

    upload_elapsed=$((SECONDS - upload_started))
    echo "runner upload failed: host=${host} attempt=${upload_attempt}/2 status=${upload_status} elapsed_seconds=${upload_elapsed} expected_bytes=${runner_size} candidate=${tmp_runner}" >&2
    case "$upload_status" in
      124|141|255) ;; # Operation timeout, broken pipe, or SSH transport failure.
      *) return "$upload_status" ;;
    esac
    if [ "$upload_attempt" -eq 2 ]; then
      return "$upload_status"
    fi
    echo "retrying runner upload on ${host} in 5s with a fresh candidate" >&2
    sleep 5
  done

  if ! ssh "$remote" bash -s -- "${tmp_runner}" "${BIN_DIR}/runner" "${runner_sha}" <<'REMOTE_SCRIPT'
set -euo pipefail
TMP_RUNNER=$1
FINAL_RUNNER=$2
EXPECTED_SHA=$3

cleanup_tmp() {
  sudo rm -f "${TMP_RUNNER}"
}
trap cleanup_tmp EXIT

actual_sha=$(sudo sha256sum "${TMP_RUNNER}" | awk '{print $1}')
if [ "${actual_sha}" != "${EXPECTED_SHA}" ]; then
  echo "runner sha mismatch: ${actual_sha} != ${EXPECTED_SHA}" >&2
  exit 1
fi

sudo "${TMP_RUNNER}" --version >/dev/null
sudo mv -f "${TMP_RUNNER}" "${FINAL_RUNNER}"
trap - EXIT
REMOTE_SCRIPT
  then
    return 1
  fi

  if [ -n "${OKOU_CLI_ARTIFACT_DIR:-}" ]; then
    if ! upload_okou_cli_artifact "$host" "$host_index"; then
      return 1
    fi
  fi

  local gc_attempt gc_status
  gc_status=0
  for gc_attempt in 1 2; do
    if ssh "$remote" sudo "${BIN_DIR}/runner" gc --keep-latest 6; then
      gc_status=0
      break
    else
      gc_status=$?
    fi

    if [ "$gc_status" -ne 255 ] || [ "$gc_attempt" -eq 2 ]; then
      echo "runner GC failed on ${host} with status ${gc_status}" >&2
      return "$gc_status"
    fi
    echo "runner GC SSH transport failed on ${host} with status 255; retrying once" >&2
  done

  if ! ssh "$remote" sudo "${BIN_DIR}/runner" setup; then
    return 1
  fi
  echo "=== Done preparing ${host} ==="
}

# Stage the Okou CLI artifact next to the runner binary. Each file goes through
# a private candidate, is checksummed on the host, and is only then moved to
# its final name, mirroring the runner binary upload.
upload_okou_cli_artifact() {
  local host=$1
  local host_index=$2
  local remote="${METAL_USER}@${host}"
  local artifact_file expected_sha tmp_candidate
  echo "=== Staging Okou CLI artifact on ${host} ==="
  if ! ssh "$remote" sudo mkdir -p "$OKOU_CLI_DIR"; then
    return 1
  fi
  for artifact_file in package.tgz manifest.json; do
    expected_sha=$(sha256sum "${OKOU_CLI_ARTIFACT_DIR}/${artifact_file}" | awk '{print $1}')
    if ! tmp_candidate=$(ssh "$remote" bash -s -- "${OKOU_CLI_DIR}/${artifact_file}.${head_sha}.${host_index}.tmp.XXXXXX" <<'REMOTE_SCRIPT'
set -euo pipefail
sudo mktemp "$1"
REMOTE_SCRIPT
    ); then
      return 1
    fi
    if ! OKOU_CLOUDFLARE_SSH_OPERATION_TIMEOUT_SECONDS=120 \
      ssh "$remote" sudo install -m 644 /dev/stdin "${tmp_candidate}" < "${OKOU_CLI_ARTIFACT_DIR}/${artifact_file}"; then
      return 1
    fi
    if ! ssh "$remote" bash -s -- "${tmp_candidate}" "${OKOU_CLI_DIR}/${artifact_file}" "${expected_sha}" <<'REMOTE_SCRIPT'
set -euo pipefail
TMP_FILE=$1
FINAL_FILE=$2
EXPECTED_SHA=$3

cleanup_tmp() {
  sudo rm -f "${TMP_FILE}"
}
trap cleanup_tmp EXIT

actual_sha=$(sudo sha256sum "${TMP_FILE}" | awk '{print $1}')
if [ "${actual_sha}" != "${EXPECTED_SHA}" ]; then
  echo "okou cli artifact sha mismatch: ${actual_sha} != ${EXPECTED_SHA}" >&2
  exit 1
fi
sudo mv -f "${TMP_FILE}" "${FINAL_FILE}"
trap - EXIT
REMOTE_SCRIPT
    then
      return 1
    fi
  done
  echo "=== Done staging Okou CLI artifact on ${host} ==="
}

warm_rootfs_cache() {
  local host=$1
  local remote="${METAL_USER}@${host}"
  echo "=== Warming shared template cache on ${host} ==="
  if ! ssh "$remote" sudo \
    R2_ACCOUNT_ID="${R2_ACCOUNT_ID:-}" \
    R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}" \
    R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}" \
    R2_USER_STORAGES_BUCKET_NAME="${R2_USER_STORAGES_BUCKET_NAME:-}" \
    "${BIN_DIR}/runner" build --profile "$PROFILE" --warm-rootfs-cache; then
    return 1
  fi
  echo "=== Done warming shared template cache on ${host} ==="
}

build_snapshot_on_host() {
  local host=$1
  local remote="${METAL_USER}@${host}"
  local build_args=(build --profile "$PROFILE")
  if [ -n "${OKOU_CLI_ARTIFACT_DIR:-}" ]; then
    build_args+=(--okou-cli-artifact "$OKOU_CLI_DIR")
  fi
  echo "=== Building rootfs/snapshot on ${host} ==="
  if ! ssh "$remote" sudo \
    R2_ACCOUNT_ID="${R2_ACCOUNT_ID:-}" \
    R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}" \
    R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}" \
    R2_USER_STORAGES_BUCKET_NAME="${R2_USER_STORAGES_BUCKET_NAME:-}" \
    "${BIN_DIR}/runner" "${build_args[@]}"; then
    return 1
  fi
  echo "=== Done building rootfs/snapshot on ${host} ==="
}

LOG_DIR=$(mktemp -d)
cleanup() {
  rm -rf "$LOG_DIR"
}
trap cleanup EXIT

PIDS=()
for i in "${!HOSTS[@]}"; do
  host="${HOSTS[$i]}"
  host_index=$((i + 1))
  prepare_host "$host" "$host_index" > "${LOG_DIR}/${host}.prepare.log" 2>&1 &
  PIDS+=($!)
done

FAILED=0
for i in "${!PIDS[@]}"; do
  if ! wait "${PIDS[$i]}"; then
    FAILED=1
    echo "::error::Runner preparation failed on ${HOSTS[$i]}"
  fi
  echo "=== ${HOSTS[$i]} prepare ==="
  cat "${LOG_DIR}/${HOSTS[$i]}.prepare.log"
done
[ "$FAILED" -eq 0 ] || exit 1

WARM_HOST="${HOSTS[0]}"
if ! warm_rootfs_cache "$WARM_HOST" 2>&1 | tee "${LOG_DIR}/warm-rootfs-cache.log"; then
  echo "::error::Shared template cache warm failed on ${WARM_HOST}"
  exit 1
fi

PIDS=()
for host in "${HOSTS[@]}"; do
  build_snapshot_on_host "$host" > "${LOG_DIR}/${host}.build.log" 2>&1 &
  PIDS+=($!)
done

FAILED=0
for i in "${!PIDS[@]}"; do
  if ! wait "${PIDS[$i]}"; then
    FAILED=1
    echo "::error::Runner image build failed on ${HOSTS[$i]}"
  fi
  echo "=== ${HOSTS[$i]} build ==="
  cat "${LOG_DIR}/${HOSTS[$i]}.build.log"
done
[ "$FAILED" -eq 0 ] || exit 1

hosts_json=$(jq -n '{}')
rootfs_map=$(jq -n '{}')
snapshot_map=$(jq -n '{}')
for host in "${HOSTS[@]}"; do
  rootfs_hash=$(grep '^rootfs_hash=' "${LOG_DIR}/${host}.build.log" | tail -n1 | cut -d= -f2 || true)
  snapshot_hash=$(grep '^snapshot_hash=' "${LOG_DIR}/${host}.build.log" | tail -n1 | cut -d= -f2 || true)
  if [ -z "$rootfs_hash" ] || [ -z "$snapshot_hash" ]; then
    echo "::error::Failed to extract rootfs/snapshot hash from ${host} log"
    exit 1
  fi
  completed_at=$(date -u +%FT%TZ)
  hosts_json=$(jq -c \
    --arg h "$host" \
    --arg rootfs "$rootfs_hash" \
    --arg snapshot "$snapshot_hash" \
    --arg completed "$completed_at" \
    '. + {($h): {rootfsHash: $rootfs, snapshotHash: $snapshot, completedAt: $completed}}' \
    <<<"$hosts_json")
  rootfs_map=$(jq -c --arg h "$host" --arg v "$rootfs_hash" '. + {($h): $v}' <<<"$rootfs_map")
  snapshot_map=$(jq -c --arg h "$host" --arg v "$snapshot_hash" '. + {($h): $v}' <<<"$snapshot_map")
done

tmp_manifest="${MANIFEST_PATH}.tmp"
jq -n \
  --arg head_sha "$head_sha" \
  --arg job_ref "$job_ref" \
  --arg target "$TARGET_TRIPLE" \
  --arg profile "$PROFILE" \
  --arg bin_dir "$BIN_DIR" \
  --arg runner_dir "$RUNNER_DIR" \
  --arg runner_sha "$runner_sha" \
  --argjson guest_sha "$guest_sha_json" \
  --argjson okou_cli "$okou_cli_json" \
  --argjson hosts "$hosts_json" \
  '{
    schemaVersion: 1,
    headSha: $head_sha,
    jobRef: $job_ref,
    target: $target,
    profile: $profile,
    binDir: $bin_dir,
    runnerDir: $runner_dir,
    runnerSha256: $runner_sha,
    guestSha256: $guest_sha,
    okouCli: $okou_cli,
    hosts: $hosts
  }' > "$tmp_manifest"
mv "$tmp_manifest" "$MANIFEST_PATH"

echo "manifest-path=${MANIFEST_PATH}"
echo "bin-dir=${BIN_DIR}"
echo "runner-dir=${RUNNER_DIR}"
echo "rootfs-hash-map=${rootfs_map}"
echo "snapshot-hash-map=${snapshot_map}"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "manifest-path=${MANIFEST_PATH}"
    echo "bin-dir=${BIN_DIR}"
    echo "runner-dir=${RUNNER_DIR}"
    echo "rootfs-hash-map=${rootfs_map}"
    echo "snapshot-hash-map=${snapshot_map}"
  } >> "$GITHUB_OUTPUT"
fi
