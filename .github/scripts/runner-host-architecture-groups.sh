#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "${SCRIPT_DIR}/runner-image-target.sh"

usage() {
  cat <<'USAGE'
Usage: runner-host-architecture-groups.sh [matrix|validation-plan KEY|target-matrix|has-groups|hosts ID|select-context KEY|select-host ID KEY [HOSTS]]

Emits compact JSON for configured runner host architecture groups.
Inputs:
  AWS_METAL_RUNNER_HOSTS      Metal runner host list.
  METAL_USER                  SSH user for metal runner hosts.

Commands:
  <none>      Emit the full local contract, including hosts.
  matrix      Emit the cross-job matrix contract, excluding hosts.
  validation-plan KEY  Emit the full matrix, selected target, and remaining validation matrix.
  target-matrix  Emit the deploy/rollback matrix contract: id, label, target.
  has-groups  Emit true when at least one host group is configured.
  hosts ID            Emit comma-separated hosts for the given architecture group.
  select-context KEY      Emit one deterministic host and its architecture context.
  select-host ID KEY [HOSTS]  Emit one deterministic host from the given architecture group.
USAGE
}

normalize_hosts() {
  local hosts="${1:-}"
  printf '%s\n' "$hosts" \
    | tr ',' '\n' \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' \
    | sed '/^$/d' \
    | paste -sd, -
}

append_group() {
  local groups=$1
  local id=$2
  local label=$3
  local hosts=$4
  local target=$5

  hosts=$(normalize_hosts "$hosts")
  if [ -z "$hosts" ]; then
    printf '%s\n' "$groups"
    return 0
  fi

  local uname_m cache_suffix asset_suffix
  uname_m=$(runner_image_expected_uname_m "$target")
  cache_suffix=$(runner_image_cache_suffix "$target")
  asset_suffix=$(runner_image_asset_suffix "$target")

  jq -c \
    --arg id "$id" \
    --arg label "$label" \
    --arg hosts "$hosts" \
    --arg target "$target" \
    --arg uname_m "$uname_m" \
    --arg cache_suffix "$cache_suffix" \
    --arg asset_suffix "$asset_suffix" \
    '. + [{
      id: $id,
      label: $label,
      hosts: $hosts,
      target: $target,
      unameM: $uname_m,
      cacheSuffix: $cache_suffix,
      assetSuffix: $asset_suffix
    }]' <<<"$groups"
}

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 2
  fi
}

append_csv() {
  local current=$1 value=$2
  if [ -n "$current" ]; then
    printf '%s,%s\n' "$current" "$value"
  else
    printf '%s\n' "$value"
  fi
}

validate_host_entry() {
  local host=$1
  if [[ ! "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$ ]]; then
    echo "invalid runner host entry: ${host}" >&2
    return 2
  fi
}

validate_hosts_csv() {
  local hosts=$1
  local host host_key host_lines
  host_lines=$(printf '%s\n' "$hosts" | tr ',' '\n')
  while IFS= read -r host; do
    validate_host_entry "$host" || return $?
  done <<<"$host_lines"

  declare -A seen_hosts=()
  while IFS= read -r host; do
    host_key=${host,,}
    if [ -n "${seen_hosts[$host_key]+x}" ]; then
      echo "duplicate runner host configured: ${host}" >&2
      return 2
    fi
    seen_hosts[$host_key]=1
  done <<<"$host_lines"
}

host_uname_m() {
  local host=$1
  local remote_arch
  remote_arch=$(ssh -n "${METAL_USER}@${host}" uname -m) || return $?
  printf '%s\n' "$remote_arch" | tail -n1 | tr -d '\r'
}

emit_groups() {
  local groups hosts arm64_hosts="" x86_64_hosts=""
  hosts=$(normalize_hosts "${AWS_METAL_RUNNER_HOSTS:-}")
  if [ -z "$hosts" ]; then
    jq -n -c '[]'
    return 0
  fi

  require_env METAL_USER
  validate_hosts_csv "$hosts" || return $?

  local host host_lines uname_m target
  host_lines=$(printf '%s\n' "$hosts" | tr ',' '\n')
  while IFS= read -r host; do
    uname_m=$(host_uname_m "$host") || return $?
    if [ -z "$uname_m" ]; then
      echo "missing runner host architecture for ${host}" >&2
      return 2
    fi
    if ! target=$(runner_image_target_for_uname_m "$uname_m" 2>/dev/null); then
      echo "unsupported runner host architecture for ${host}: ${uname_m}" >&2
      return 2
    fi
    case "$target" in
      aarch64-unknown-linux-musl)
        arm64_hosts=$(append_csv "$arm64_hosts" "$host")
        ;;
      x86_64-unknown-linux-musl)
        x86_64_hosts=$(append_csv "$x86_64_hosts" "$host")
        ;;
      *)
        echo "unsupported runner host target for ${host}: ${target}" >&2
        return 2
        ;;
    esac
  done <<<"$host_lines"

  groups=$(jq -n -c '[]')
  groups=$(append_group "$groups" "arm64" "arm64" "$arm64_hosts" "aarch64-unknown-linux-musl")
  groups=$(append_group "$groups" "x86_64" "x86_64" "$x86_64_hosts" "x86_64-unknown-linux-musl")
  printf '%s\n' "$groups"
}

emit_matrix() {
  local groups
  groups=$(emit_groups) || return $?
  matrix_from_groups "$groups"
}

matrix_from_groups() {
  local groups=$1
  jq -c 'map({
    id,
    label,
    target,
    unameM,
    cacheSuffix,
    assetSuffix
  })' <<<"$groups"
}

emit_target_matrix() {
  local groups
  groups=$(emit_groups) || return $?
  jq -c 'map({
    id,
    label,
    target
  })' <<<"$groups"
}

emit_has_groups() {
  local groups
  groups=$(emit_groups) || return $?
  if jq -e 'length > 0' >/dev/null <<<"$groups"; then
    printf 'true\n'
  else
    printf 'false\n'
  fi
}

validate_group_id() {
  local group_id=${1:-}
  if [ -z "$group_id" ]; then
    echo "missing runner host group id" >&2
    return 2
  fi

  case "$group_id" in
    arm64|x86_64) ;;
    *)
      echo "unsupported runner host group id: ${group_id}" >&2
      return 2
      ;;
  esac
}

emit_hosts() {
  local group_id=${1:-}
  validate_group_id "$group_id" || return $?

  local groups
  groups=$(emit_groups) || return $?
  jq -r --arg id "$group_id" '.[] | select(.id == $id) | .hosts' <<<"$groups"
}

validate_selection_key() {
  local selection_key=${1:-}
  if [ -z "$selection_key" ]; then
    echo "missing runner host context selection key" >&2
    return 2
  fi
}

selected_context_from_groups() {
  local selection_key=$1 groups=$2
  local contexts context_count
  contexts=$(jq -c '[.[] as $group | $group.hosts | split(",")[] | {
    host: .,
    groupId: $group.id,
    target: $group.target,
    groupHosts: $group.hosts
  }]' <<<"$groups")
  context_count=$(jq -r 'length' <<<"$contexts")
  if [ "$context_count" -lt 1 ]; then
    echo "no runner hosts found" >&2
    return 2
  fi

  local hash context_index
  hash=$(printf '%s' "$selection_key" | md5sum | cut -c1-8)
  context_index=$(( 0x$hash % context_count ))
  jq -c --argjson context_index "$context_index" '.[$context_index]' <<<"$contexts"
}

emit_selected_context() {
  validate_selection_key "${1:-}" || return $?
  local groups
  groups=$(emit_groups) || return $?
  selected_context_from_groups "${1:-}" "$groups"
}

emit_validation_plan() {
  validate_selection_key "${1:-}" || return $?
  local groups context matrix target
  groups=$(emit_groups) || return $?
  context=$(selected_context_from_groups "${1:-}" "$groups") || return $?
  target=$(jq -r '.target' <<<"$context")
  matrix=$(matrix_from_groups "$groups") || return $?
  jq -cn --argjson matrix "$matrix" --arg target "$target" '{
    matrix: $matrix,
    selectedTarget: $target,
    validationMatrix: ($matrix | map(select(.target != $target)))
  }'
}

emit_selected_host() {
  local group_id=${1:-}
  local selection_key=${2:-}
  local hosts=${3:-}
  validate_group_id "$group_id" || return $?
  if [ -z "$selection_key" ]; then
    echo "missing runner host selection key" >&2
    return 2
  fi

  if [ -z "$hosts" ]; then
    hosts=$(emit_hosts "$group_id") || return $?
  fi

  local -a host_list=()
  local normalized_hosts
  normalized_hosts=$(
    printf '%s\n' "$hosts" \
      | tr ',' '\n' \
      | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' \
      | sed '/^$/d'
  )
  if [ -n "$normalized_hosts" ]; then
    mapfile -t host_list <<<"$normalized_hosts"
  fi

  local host_count=${#host_list[@]}
  if [ "$host_count" -lt 1 ]; then
    echo "no runner hosts found for runner host group: ${group_id}" >&2
    return 2
  fi

  local hash host_index
  hash=$(printf '%s-%s' "$selection_key" "$group_id" | md5sum | cut -c1-8)
  host_index=$(( 0x$hash % host_count ))
  printf '%s\n' "${host_list[$host_index]}"
}

cmd="${1:-}"
case "$cmd" in
  "")
    emit_groups
    ;;
  matrix)
    emit_matrix
    ;;
  validation-plan)
    emit_validation_plan "${2:-}"
    ;;
  target-matrix)
    emit_target_matrix
    ;;
  has-groups)
    emit_has_groups
    ;;
  hosts)
    emit_hosts "${2:-}"
    ;;
  select-context)
    emit_selected_context "${2:-}"
    ;;
  select-host)
    emit_selected_host "${2:-}" "${3:-}" "${4:-}"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
