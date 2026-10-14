#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="${SCRIPT_DIR}/runner-binary-cache.sh"
DIGEST="${SCRIPT_DIR}/runner-binary-build/digest.sh"

usage() {
  cat <<'USAGE'
Usage: reconcile-runner-binary-groups.sh <check|restore>

Checks every configured metal host against the runner SHA from its image
manifest. Restore atomically installs validated cache transports only on hosts
whose per-job runner binary is missing or has the wrong SHA.

Required env:
  AWS_METAL_RUNNER_HOSTS, METAL_USER, JOB_REF, BIN_DIR, RUNNER_SHA_MAP
Restore also requires:
  RECOVERY_DIR
USAGE
}

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 2
  fi
}

emit() {
  local key=$1 value=$2
  printf '%s=%s\n' "$key" "$value"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT"
  fi
}

cmd=${1:-}
case "$cmd" in
  -h|--help|help)
    usage
    exit 0
    ;;
esac

require_env AWS_METAL_RUNNER_HOSTS
require_env METAL_USER
require_env JOB_REF
require_env BIN_DIR
require_env RUNNER_SHA_MAP

if [[ ! "$METAL_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]]; then
  echo "invalid metal runner SSH user: ${METAL_USER}" >&2
  exit 2
fi
if [ -n "${GITHUB_RUN_ID:-}" ] && [[ ! "$GITHUB_RUN_ID" =~ ^[1-9][0-9]*$ ]]; then
  echo "invalid GITHUB_RUN_ID: ${GITHUB_RUN_ID}" >&2
  exit 2
fi
if [[ ! "$JOB_REF" =~ ^(pr-[1-9][0-9]*|staging-[0-9a-f]{7,40})$ ]]; then
  echo "invalid runner image job ref: ${JOB_REF}" >&2
  exit 2
fi
expected_bin_dir="/var/lib/vm0-runner/bin/${JOB_REF}"
if [ "$BIN_DIR" != "$expected_bin_dir" ]; then
  echo "runner binary directory mismatch: ${BIN_DIR} != ${expected_bin_dir}" >&2
  exit 2
fi
if ! jq -e '
  type == "object" and length > 0 and
  all(to_entries[];
    (
      .key == "aarch64-unknown-linux-musl" or
      .key == "x86_64-unknown-linux-musl"
    ) and
    (.value | type == "string" and test("^[0-9a-f]{64}$"))
  )
' <<<"$RUNNER_SHA_MAP" >/dev/null; then
  echo "invalid runner SHA map" >&2
  exit 2
fi

groups_json=$("${SCRIPT_DIR}/runner-host-architecture-groups.sh")
if ! jq -e 'type == "array" and length > 0' <<<"$groups_json" >/dev/null; then
  echo "no runner host architecture groups found" >&2
  exit 2
fi
group_targets=$(jq -c '[.[].target] | sort' <<<"$groups_json")
sha_targets=$(jq -c 'keys | sort' <<<"$RUNNER_SHA_MAP")
if [ "$group_targets" != "$sha_targets" ]; then
  echo "runner host targets do not match runner SHA map: ${group_targets} != ${sha_targets}" >&2
  exit 2
fi
groups_matrix=$(jq -c 'map({id, label, target, unameM, cacheSuffix, assetSuffix})' <<<"$groups_json")

remote_runner_sha() {
  local host=$1
  local remote="${METAL_USER}@${host}"
  local observed
  if ! observed=$(ssh "$remote" bash -s -- "$BIN_DIR" <<'REMOTE_SCRIPT'
set -euo pipefail
BIN_DIR=$1
RUNNER_PATH="${BIN_DIR}/runner"

if ! sudo test -x "$RUNNER_PATH"; then
  echo missing
  exit 0
fi
sudo sha256sum -- "$RUNNER_PATH" | awk '{print $1}'
REMOTE_SCRIPT
  ); then
    echo "failed to inspect runner binary on ${host}" >&2
    return 1
  fi
  observed=$(printf '%s\n' "$observed" | tail -n1 | tr -d '\r')
  if [ "$observed" != "missing" ] && [[ ! "$observed" =~ ^[0-9a-f]{64}$ ]]; then
    echo "invalid runner SHA reported by ${host}: ${observed}" >&2
    return 1
  fi
  printf '%s\n' "$observed"
}

assess_recovery_targets() {
  local recovery_targets='[]'
  local group target expected_sha hosts host observed_sha group_lines host_lines
  group_lines=$(jq -c '.[]' <<<"$groups_json")
  while IFS= read -r group; do
    target=$(jq -r '.target' <<<"$group")
    expected_sha=$(jq -r --arg target "$target" '.[$target]' <<<"$RUNNER_SHA_MAP")
    hosts=$(jq -r '.hosts' <<<"$group")
    host_lines=$(printf '%s\n' "$hosts" | tr ',' '\n')
    while IFS= read -r host; do
      [ -n "$host" ] || continue
      observed_sha=$(remote_runner_sha "$host") || return $?
      if [ "$observed_sha" != "$expected_sha" ]; then
        echo "Runner binary recovery required on ${host}: expected=${expected_sha} observed=${observed_sha}" >&2
        recovery_targets=$(jq -c --arg target "$target" \
          'if index($target) then . else . + [$target] end' <<<"$recovery_targets")
      fi
    done <<<"$host_lines"
  done <<<"$group_lines"
  printf '%s\n' "$recovery_targets"
}

install_runner() {
  local host=$1 target=$2 expected_sha=$3 runner_path=$4 host_index=$5
  local remote="${METAL_USER}@${host}"
  local recovery_id="${GITHUB_RUN_ID:-local}"
  local tmp_runner="${BIN_DIR}/runner.recovery.${recovery_id}.${host_index}.tmp"

  echo "Restoring validated ${target} runner binary on ${host}"
  ssh "$remote" sudo mkdir -p -- "$BIN_DIR"
  ssh "$remote" sudo install -m 755 /dev/stdin "$tmp_runner" < "$runner_path"
  ssh "$remote" bash -s -- "$tmp_runner" "${BIN_DIR}/runner" "$expected_sha" <<'REMOTE_SCRIPT'
set -euo pipefail
TMP_RUNNER=$1
FINAL_RUNNER=$2
EXPECTED_SHA=$3

cleanup_tmp() {
  sudo rm -f -- "$TMP_RUNNER"
}
trap cleanup_tmp EXIT

actual_sha=$(sudo sha256sum -- "$TMP_RUNNER" | awk '{print $1}')
if [ "$actual_sha" != "$EXPECTED_SHA" ]; then
  echo "runner recovery SHA mismatch: ${actual_sha} != ${EXPECTED_SHA}" >&2
  exit 1
fi
sudo "$TMP_RUNNER" --version >/dev/null
sudo mv -f -- "$TMP_RUNNER" "$FINAL_RUNNER"
trap - EXIT
REMOTE_SCRIPT
}

check_binaries() {
  local recovery_targets recovery_needed=false
  recovery_targets=$(assess_recovery_targets)
  if jq -e 'length > 0' <<<"$recovery_targets" >/dev/null; then
    recovery_needed=true
  fi
  emit "recovery-needed" "$recovery_needed"
  emit "recovery-targets" "$recovery_targets"
  emit "runner-host-groups-matrix" "$groups_matrix"
}

restore_binaries() {
  local recovery_targets
  recovery_targets=$(assess_recovery_targets)
  if ! jq -e 'length > 0' <<<"$recovery_targets" >/dev/null; then
    echo "Runner binaries already match their image manifests"
    return 0
  fi

  require_env RECOVERY_DIR
  if [ "$RECOVERY_DIR" = "/" ] || [ ! -d "$RECOVERY_DIR" ] || [ -L "$RECOVERY_DIR" ]; then
    echo "runner binary recovery directory is missing or unsafe: ${RECOVERY_DIR}" >&2
    exit 2
  fi

  local target target_dir expected_sha runner_path metadata_path digest_output expected_digest transport_sha
  local group hosts host observed_sha host_index=0 target_lines host_lines
  target_lines=$(jq -r '.[]' <<<"$recovery_targets")
  while IFS= read -r target; do
    [ -n "$target" ] || continue
    expected_sha=$(jq -r --arg target "$target" '.[$target]' <<<"$RUNNER_SHA_MAP")
    target_dir="${RECOVERY_DIR}/${target}"
    runner_path="${RECOVERY_DIR}/${target}/runner"
    metadata_path="${RECOVERY_DIR}/${target}/metadata.json"
    if [ ! -d "$target_dir" ] || [ -L "$target_dir" ]; then
      echo "runner binary recovery target directory is missing or unsafe: ${target_dir}" >&2
      exit 2
    fi
    digest_output=$(env GITHUB_OUTPUT= "$DIGEST" "$target")
    expected_digest=$(sed -n 's/^binary-input-digest=//p' <<<"$digest_output" | tail -n1)
    if [[ ! "$expected_digest" =~ ^[0-9a-f]{64}$ ]]; then
      echo "runner binary digest command returned an invalid digest for ${target}" >&2
      exit 2
    fi
    env GITHUB_OUTPUT= \
      EXPECTED_TARGET="$target" \
      EXPECTED_BINARY_INPUT_DIGEST="$expected_digest" \
      FRESH_METADATA_PATH="$metadata_path" \
      RUNNER_PATH="$runner_path" \
      "$CACHE" fresh-validate >/dev/null
    transport_sha=$(jq -r '.runnerSha256' "$metadata_path")
    if [ "$transport_sha" != "$expected_sha" ]; then
      echo "validated runner transport does not match image manifest for ${target}: ${transport_sha} != ${expected_sha}" >&2
      exit 1
    fi

    group=$(jq -c --arg target "$target" '.[] | select(.target == $target)' <<<"$groups_json")
    hosts=$(jq -r '.hosts' <<<"$group")
    host_lines=$(printf '%s\n' "$hosts" | tr ',' '\n')
    while IFS= read -r host; do
      [ -n "$host" ] || continue
      observed_sha=$(remote_runner_sha "$host")
      if [ "$observed_sha" = "$expected_sha" ]; then
        continue
      fi
      host_index=$((host_index + 1))
      install_runner "$host" "$target" "$expected_sha" "$runner_path" "$host_index"
    done <<<"$host_lines"
  done <<<"$target_lines"

  recovery_targets=$(assess_recovery_targets)
  if jq -e 'length > 0' <<<"$recovery_targets" >/dev/null; then
    echo "runner binary recovery did not converge: ${recovery_targets}" >&2
    exit 1
  fi
  echo "Runner binaries match their validated image manifests on every host"
}

case "$cmd" in
  check) check_binaries ;;
  restore) restore_binaries ;;
  *) usage >&2; exit 2 ;;
esac
