#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "${SCRIPT_DIR}/runner-image-target.sh"
. "${SCRIPT_DIR}/runner-guest-binaries.sh"

usage() {
  cat <<'USAGE'
Usage: runner-image-manifest.sh validate

Validates a current-run runner image manifest and emits GitHub output values.
Required env:
  MANIFEST_PATH, HEAD_SHA, JOB_REF, TARGET, PROFILE, METAL_HOSTS
Optional env:
  SELECTED_HOST
USAGE
}

emit() {
  local key=$1 value=$2
  printf '%s=%s\n' "$key" "$value"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT"
  fi
}

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 2
  fi
}

json_get() {
  jq -r "$1 // empty" "$MANIFEST_PATH"
}

validate() {
  require_env MANIFEST_PATH
  require_env HEAD_SHA
  require_env JOB_REF
  require_env TARGET
  require_env PROFILE
  require_env METAL_HOSTS

  runner_guest_binaries_load

  runner_image_validate_target "$TARGET"

  if [ ! -f "$MANIFEST_PATH" ]; then
    echo "manifest not found: ${MANIFEST_PATH}" >&2
    exit 1
  fi

  jq empty "$MANIFEST_PATH"

  local actual
  actual=$(json_get '.schemaVersion')
  [ "$actual" = "1" ] || { echo "schemaVersion mismatch: ${actual}" >&2; exit 1; }
  actual=$(json_get '.headSha')
  [ "$actual" = "$HEAD_SHA" ] || { echo "headSha mismatch: ${actual} != ${HEAD_SHA}" >&2; exit 1; }
  actual=$(json_get '.jobRef')
  [ "$actual" = "$JOB_REF" ] || { echo "jobRef mismatch: ${actual} != ${JOB_REF}" >&2; exit 1; }
  actual=$(json_get '.target')
  [ "$actual" = "$TARGET" ] || { echo "target mismatch: ${actual} != ${TARGET}" >&2; exit 1; }
  actual=$(json_get '.profile')
  [ "$actual" = "$PROFILE" ] || { echo "profile mismatch: ${actual} != ${PROFILE}" >&2; exit 1; }

  local bin_dir runner_dir runner_sha
  bin_dir=$(json_get '.binDir')
  runner_dir=$(json_get '.runnerDir')
  runner_sha=$(json_get '.runnerSha256')
  [ -n "$bin_dir" ] || { echo "manifest missing binDir" >&2; exit 1; }
  [ -n "$runner_dir" ] || { echo "manifest missing runnerDir" >&2; exit 1; }
  [ -n "$runner_sha" ] || { echo "manifest missing runnerSha256" >&2; exit 1; }

  for guest in "${RUNNER_GUEST_BINARIES[@]}"; do
    actual=$(jq -r --arg guest "$guest" '.guestSha256[$guest] // empty' "$MANIFEST_PATH")
    [ -n "$actual" ] || { echo "manifest missing guestSha256.${guest}" >&2; exit 1; }
  done

  local rootfs_map snapshot_map
  rootfs_map=$(jq -n -c '{}')
  snapshot_map=$(jq -n -c '{}')
  local host_count=0
  while IFS= read -r host; do
    [ -n "$host" ] || continue
    host_count=$((host_count + 1))
    local rootfs snapshot
    rootfs=$(jq -r --arg h "$host" '.hosts[$h].rootfsHash // empty' "$MANIFEST_PATH")
    snapshot=$(jq -r --arg h "$host" '.hosts[$h].snapshotHash // empty' "$MANIFEST_PATH")
    [ -n "$rootfs" ] || { echo "manifest missing rootfsHash for ${host}" >&2; exit 1; }
    [ -n "$snapshot" ] || { echo "manifest missing snapshotHash for ${host}" >&2; exit 1; }
    rootfs_map=$(jq -c --arg h "$host" --arg v "$rootfs" '. + {($h): $v}' <<<"$rootfs_map")
    snapshot_map=$(jq -c --arg h "$host" --arg v "$snapshot" '. + {($h): $v}' <<<"$snapshot_map")
  done < <(printf '%s\n' "$METAL_HOSTS" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep .)

  [ "$host_count" -gt 0 ] || { echo "METAL_HOSTS is empty" >&2; exit 1; }

  emit "manifest-path" "$MANIFEST_PATH"
  emit "bin-dir" "$bin_dir"
  emit "runner-dir" "$runner_dir"
  emit "runner-sha" "$runner_sha"
  emit "rootfs-hash-map" "$rootfs_map"
  emit "snapshot-hash-map" "$snapshot_map"

  if [ -n "${SELECTED_HOST:-}" ]; then
    local selected_rootfs selected_snapshot
    selected_rootfs=$(jq -r --arg h "$SELECTED_HOST" '.hosts[$h].rootfsHash // empty' "$MANIFEST_PATH")
    selected_snapshot=$(jq -r --arg h "$SELECTED_HOST" '.hosts[$h].snapshotHash // empty' "$MANIFEST_PATH")
    [ -n "$selected_rootfs" ] || { echo "manifest missing selected host ${SELECTED_HOST}" >&2; exit 1; }
    [ -n "$selected_snapshot" ] || { echo "manifest missing selected host ${SELECTED_HOST}" >&2; exit 1; }
    emit "selected-rootfs-hash" "$selected_rootfs"
    emit "selected-snapshot-hash" "$selected_snapshot"
  fi
}

cmd="${1:-}"
case "$cmd" in
  validate) validate ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
