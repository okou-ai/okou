#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.github/scripts/runner/cloudflare-ssh-diagnostics.sh
. "${SCRIPT_DIR}/cloudflare-ssh-diagnostics.sh"

usage() {
  echo "Usage: $0 [--control-path <path>] <ssh-user> <ssh-hosts> [require-all-hosts]" >&2
}

CONTROL_PATH=""
if [ "${1:-}" = "--control-path" ]; then
  if [ "$#" -lt 2 ] || [ -z "$2" ]; then
    usage
    exit 2
  fi
  CONTROL_PATH="$2"
  shift 2
fi

SSH_USER="${1:-}"
SSH_HOSTS="${2:-}"
REQUIRE_ALL_HOSTS="${3:-true}"
RETRY_DELAYS_SECONDS=(1 5 15)
MAX_ATTEMPTS=$((${#RETRY_DELAYS_SECONDS[@]} + 1))
MASTER_START_TIMEOUT_SECONDS=40
MASTER_START_KILL_AFTER_SECONDS=5
CONTROL_TIMEOUT_SECONDS=5
CONTROL_KILL_AFTER_SECONDS=2
CLOUDFLARE_SSH_BIN="${CLOUDFLARE_SSH_BIN:-ssh}"

if [ -z "$SSH_USER" ] || [ -z "$SSH_HOSTS" ]; then
  usage
  exit 2
fi

if [[ ! "$SSH_USER" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid SSH user: ${SSH_USER}" >&2
  exit 2
fi

if [ "$REQUIRE_ALL_HOSTS" != "true" ] && [ "$REQUIRE_ALL_HOSTS" != "false" ]; then
  echo "require-all-hosts must be true or false" >&2
  exit 2
fi

if [ -n "$CONTROL_PATH" ]; then
  if [[ "$CONTROL_PATH" != /* ]]; then
    echo "Control path must be absolute: ${CONTROL_PATH}" >&2
    exit 2
  fi
  if [ ! -d "$(dirname "$CONTROL_PATH")" ]; then
    echo "Control path directory does not exist: $(dirname "$CONTROL_PATH")" >&2
    exit 2
  fi
fi

connected_targets=()
connected_control_paths=()
connected_diagnostics_files=()

bounded_control_command() {
  local control_path="$1"
  local operation="$2"
  local target="$3"
  local -a control_args=()
  if [ -n "$control_path" ]; then
    control_args=(-S "$control_path")
  fi
  timeout \
    --kill-after="${CONTROL_KILL_AFTER_SECONDS}s" \
    "${CONTROL_TIMEOUT_SECONDS}s" \
    "$CLOUDFLARE_SSH_BIN" "${control_args[@]}" -n -O "$operation" "$target"
}

cleanup() {
  local status=$?
  local index target control_path
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    for index in "${!connected_targets[@]}"; do
      target="${connected_targets[$index]}"
      control_path="${connected_control_paths[$index]}"
      bounded_control_command "$control_path" exit "$target" \
        > /dev/null 2>&1 || true
      rm -f "${connected_diagnostics_files[$index]}"
    done
  fi
  exit "$status"
}
trap cleanup EXIT

emit_failure() {
  local host="$1"
  local reason="$2"
  local diagnostics_file="$3"
  local annotation="error"

  if [ "$REQUIRE_ALL_HOSTS" = "false" ]; then
    annotation="warning"
  fi

  echo "::${annotation} title=Cloudflare SSH preconnection failed::Unable to establish replay-safe SSH transport to ${host}: ${reason}" >&2
  if [ -s "$diagnostics_file" ] || [ -d "${diagnostics_file}.proxies" ]; then
    echo "----- SSH preconnection diagnostics (bounded, redacted) -----" >&2
    cloudflare_ssh_emit_master_diagnostics "$diagnostics_file" || true
  fi
}

emit_retry_diagnostics() {
  local diagnostics_file="$1"
  if [ -s "$diagnostics_file" ] || [ -d "${diagnostics_file}.proxies" ]; then
    echo "----- transient SSH preconnection diagnostics (bounded, redacted) -----" >&2
    cloudflare_ssh_emit_master_diagnostics "$diagnostics_file" || true
  fi
}

is_transient_status() {
  local status="$1"
  case "$status" in
    124|137|255)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

preconnect_host() {
  local host="$1"
  local target="${SSH_USER}@${host}"
  local attempt stderr_file status
  local -a control_args=()
  if [ -n "$CONTROL_PATH" ]; then
    control_args=(-S "$CONTROL_PATH")
  fi

  for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
    stderr_file=$(cloudflare_ssh_master_diagnostics_file \
      "$SSH_USER" "$host" "$CONTROL_PATH") || return
    # The detached master keeps this descriptor after setup returns. Retain
    # its log for the job's lifetime so later caller failures can read it.
    (umask 077; : > "$stderr_file") || return
    chmod 600 "$stderr_file" || return
    printf 'SSH master starting: host=%s attempt=%s time=%s\n' \
      "$host" "$attempt" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$stderr_file" || return
    status=0

    # -v also keeps stderr open after OpenSSH forks into the background;
    # setting LogLevel alone would discard post-authentication diagnostics.
    OKOU_CLOUDFLARE_SSH_PROXY_DIAGNOSTICS_DIR="${stderr_file}.proxies" \
      GITHUB_STEP_SUMMARY="" \
      timeout \
        --kill-after="${MASTER_START_KILL_AFTER_SECONDS}s" \
        "${MASTER_START_TIMEOUT_SECONDS}s" \
        "$CLOUDFLARE_SSH_BIN" "${control_args[@]}" -v -n -M -N -f "$target" \
        2>> "$stderr_file" || status=$?

    if [ "$status" -eq 0 ]; then
      GITHUB_STEP_SUMMARY="" \
        bounded_control_command "$CONTROL_PATH" check "$target" \
        2>> "$stderr_file" || status=$?
      if [ "$status" -eq 0 ]; then
        connected_targets+=("$target")
        connected_control_paths+=("$CONTROL_PATH")
        connected_diagnostics_files+=("$stderr_file")
        echo "Established replay-safe SSH transport to ${host}"
        return 0
      fi

      GITHUB_STEP_SUMMARY="" \
        bounded_control_command "$CONTROL_PATH" exit "$target" \
        >> "$stderr_file" 2>&1 || true
    fi

    if ! is_transient_status "$status" \
      || cloudflare_ssh_is_permanent_failure "$stderr_file"; then
      emit_failure "$host" "permanent connection failure (exit ${status})" "$stderr_file"
      return "$status"
    fi

    if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
      emit_failure "$host" "retry limit reached after ${MAX_ATTEMPTS} attempts" "$stderr_file"
      return "$status"
    fi

    echo "::warning title=Retrying Cloudflare SSH preconnection::Transient SSH transport failure for ${host} on attempt ${attempt}/${MAX_ATTEMPTS}; retrying before any remote command is submitted" >&2
    emit_retry_diagnostics "$stderr_file"
    sleep "${RETRY_DELAYS_SECONDS[$((attempt - 1))]}"
  done
}

host_lines=$(printf '%s\n' "$SSH_HOSTS" \
  | tr ',' '\n' \
  | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' \
  | sed '/^$/d')

if [ -z "$host_lines" ]; then
  echo "No SSH hosts configured" >&2
  exit 2
fi

if [ -n "$CONTROL_PATH" ] \
  && [ "$(printf '%s\n' "$host_lines" | wc -l)" -ne 1 ]; then
  echo "An explicit control path requires exactly one SSH host" >&2
  exit 2
fi

declare -A seen_hosts=()
while IFS= read -r host; do
  if [[ ! "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$ ]]; then
    echo "Invalid SSH host: ${host}" >&2
    exit 2
  fi

  host_key=${host,,}
  if [ -n "${seen_hosts[$host_key]+x}" ]; then
    continue
  fi
  seen_hosts[$host_key]=1

  preconnect_status=0
  preconnect_host "$host" || preconnect_status=$?
  if [ "$preconnect_status" -ne 0 ]; then
    rm -f "$(cloudflare_ssh_master_diagnostics_file \
      "$SSH_USER" "$host" "$CONTROL_PATH")"
  fi
  if [ "$preconnect_status" -ne 0 ] && [ "$REQUIRE_ALL_HOSTS" = "true" ]; then
    exit "$preconnect_status"
  fi
done <<< "$host_lines"
