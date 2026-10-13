#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "error: $name is required" >&2
    exit 1
  fi
}

emit() {
  local key="$1"
  local value="$2"
  echo "$key=$value" >>"$GITHUB_OUTPUT"
}

output_value() {
  local key="$1"
  local file="$2"
  sed -n "s/^${key}=//p" "$file" | tail -n 1
}

merge_json_map() {
  local lhs="$1"
  local rhs="$2"
  jq -c --argjson rhs "$rhs" '. + $rhs' <<<"$lhs"
}

require_env HEAD_SHA
require_env JOB_REF
require_env AWS_METAL_RUNNER_HOSTS
require_env METAL_USER
require_env PROFILE
require_env GITHUB_OUTPUT

base_output_dir="${OUTPUT_DIR:-/tmp/runner-image-manifests}"
groups_json="$("$SCRIPT_DIR/runner-host-architecture-groups.sh")"
group_count="$(jq -r 'length' <<<"$groups_json")"

if [ "$group_count" = "0" ]; then
  echo "error: no runner host architecture groups found" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

bin_dir=""
runner_dir=""
rootfs_hash_map="{}"
snapshot_hash_map="{}"
runner_sha_map="{}"

while IFS= read -r group; do
  group_id="$(jq -r '.id' <<<"$group")"
  target="$(jq -r '.target' <<<"$group")"
  hosts="$(jq -r '.hosts' <<<"$group")"

  if [ -z "$hosts" ]; then
    echo "error: runner host group $group_id has no hosts" >&2
    exit 1
  fi

  group_output="$tmp_dir/${group_id}.out"
  group_output_dir="$base_output_dir/$group_id"

  echo "Waiting for runner image manifest for $group_id ($target)"
  GITHUB_OUTPUT="$group_output" \
    OUTPUT_DIR="$group_output_dir" \
    TARGET="$target" \
    METAL_HOSTS="$hosts" \
    "$SCRIPT_DIR/wait-runner-image.sh"

  group_bin_dir="$(output_value bin-dir "$group_output")"
  group_runner_dir="$(output_value runner-dir "$group_output")"
  group_runner_sha="$(output_value runner-sha "$group_output")"
  group_rootfs_hash_map="$(output_value rootfs-hash-map "$group_output")"
  group_snapshot_hash_map="$(output_value snapshot-hash-map "$group_output")"

  if [ -z "$group_bin_dir" ] || [ -z "$group_runner_dir" ] || [ -z "$group_runner_sha" ]; then
    echo "error: runner image manifest for $group_id did not emit bin-dir, runner-dir, and runner-sha" >&2
    exit 1
  fi
  if [[ ! "$group_runner_sha" =~ ^[0-9a-f]{64}$ ]]; then
    echo "error: runner image manifest for $group_id emitted an invalid runner-sha" >&2
    exit 1
  fi

  if [ -n "$bin_dir" ] && [ "$bin_dir" != "$group_bin_dir" ]; then
    echo "error: runner image manifests disagree on bin-dir: $bin_dir != $group_bin_dir" >&2
    exit 1
  fi
  if [ -n "$runner_dir" ] && [ "$runner_dir" != "$group_runner_dir" ]; then
    echo "error: runner image manifests disagree on runner-dir: $runner_dir != $group_runner_dir" >&2
    exit 1
  fi

  bin_dir="$group_bin_dir"
  runner_dir="$group_runner_dir"
  runner_sha_map="$(jq -c \
    --arg target "$target" \
    --arg sha "$group_runner_sha" \
    '. + {($target): $sha}' <<<"$runner_sha_map")"
  rootfs_hash_map="$(merge_json_map "$rootfs_hash_map" "$group_rootfs_hash_map")"
  snapshot_hash_map="$(merge_json_map "$snapshot_hash_map" "$group_snapshot_hash_map")"
done < <(jq -c '.[]' <<<"$groups_json")

emit "bin-dir" "$bin_dir"
emit "runner-dir" "$runner_dir"
emit "runner-sha-map" "$runner_sha_map"
emit "rootfs-hash-map" "$rootfs_hash_map"
emit "snapshot-hash-map" "$snapshot_hash_map"
