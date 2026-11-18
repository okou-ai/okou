#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=.github/scripts/runner/cloudflare-ssh-diagnostics.sh
source "$(dirname "${BASH_SOURCE[0]}")/cloudflare-ssh-diagnostics.sh"

usage() {
  cat <<'USAGE'
Usage: with-runner-lifecycle-lock.sh <command> [args...]

Acquires the per-runner-namespace lifecycle lock on every configured metal
host, runs the command while every lock is held, then releases the locks.

Each remote holder keeps the lock only while this script keeps heartbeating
over the same SSH channel, so a holder that loses its owner releases the lock
instead of blocking the host until the transport is reaped.

Required env:
  JOB_REF, METAL_HOSTS, METAL_USER
Optional env:
  RUNNER_LIFECYCLE_LOCK_TIMEOUT_SECONDS (default: 480)
  RUNNER_LIFECYCLE_LOCK_LEASE_SECONDS (default: 150)
USAGE
}

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 2
  fi
}

case "${1:-}" in
  -h|--help|help)
    usage
    exit 0
    ;;
esac

if [ "$#" -eq 0 ]; then
  usage >&2
  exit 2
fi

require_env JOB_REF
require_env METAL_HOSTS
require_env METAL_USER

if [[ ! "$METAL_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]]; then
  echo "invalid metal runner SSH user: ${METAL_USER}" >&2
  exit 2
fi
if [[ ! "$JOB_REF" =~ ^(pr-[1-9][0-9]*|staging-[0-9a-f]{7,40})$ ]]; then
  echo "invalid runner lifecycle job ref: ${JOB_REF}" >&2
  exit 2
fi

lock_timeout=${RUNNER_LIFECYCLE_LOCK_TIMEOUT_SECONDS:-480}
if [[ ! "$lock_timeout" =~ ^[1-9][0-9]*$ ]] || [ "$lock_timeout" -gt 3600 ]; then
  echo "runner lifecycle lock timeout must be an integer from 1 through 3600 seconds" >&2
  exit 2
fi
ready_timeout=$((lock_timeout + 30))

# A remote holder cannot observe a half-open SSH transport, so it releases the
# lock once this many seconds pass without a heartbeat from its owner.
lease_timeout=${RUNNER_LIFECYCLE_LOCK_LEASE_SECONDS:-150}
if [[ ! "$lease_timeout" =~ ^[1-9][0-9]*$ ]] || [ "$lease_timeout" -lt 5 ] ||
  [ "$lease_timeout" -gt 3600 ]; then
  echo "runner lifecycle lock lease must be an integer from 5 through 3600 seconds" >&2
  exit 2
fi
# Five heartbeats per lease keep a busy CI host from expiring a live holder.
# The validated five-second floor above keeps this interval at one second or more.
heartbeat_interval=$((lease_timeout / 5))

normalized_hosts=$(
  printf '%s\n' "$METAL_HOSTS" |
    tr ',' '\n' |
    sed 's/^[[:space:]]*//; s/[[:space:]]*$//; /^$/d' |
    LC_ALL=C sort -u
)
hosts=()
while IFS= read -r host; do
  [ -n "$host" ] || continue
  hosts+=("$host")
done <<<"$normalized_hosts"
if [ "${#hosts[@]}" -eq 0 ]; then
  echo "no metal runner hosts configured" >&2
  exit 2
fi
for host in "${hosts[@]}"; do
  if [[ ! "$host" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then
    echo "invalid metal runner host: ${host}" >&2
    exit 2
  fi
done

IFS= read -r release_id </proc/sys/kernel/random/uuid
receipt_path="/run/vm0-runner-lifecycle-receipts/${JOB_REF}"
umask 077
state_dir=$(mktemp -d)
declare -a lock_fds=()
declare -a lock_hosts=()
declare -a lock_pids=()
declare -a heartbeat_pids=()
command_pid=""
locks_released=false
phase=acquire

holder_script=$(cat <<'REMOTE'
set -euo pipefail
lock_timeout=$1
lock_path=$2
lease_timeout=$3
receipt_path=$4
release_id=$5
holder_status=0
flock --exclusive --timeout "$lock_timeout" "$lock_path" bash -c '
  printf "%s\n" VM0_RUNNER_LIFECYCLE_LOCK_ACQUIRED
  while :; do
    read_status=0
    IFS= read -r -t "$1" message || read_status=$?
    case $read_status in
      0)
        if [ "$message" = VM0_RUNNER_LIFECYCLE_LOCK_RELEASE ]; then
          exit 42
        fi
        ;;
      1) printf "%s\n" VM0_RUNNER_LIFECYCLE_LOCK_INPUT_EOF >&2; exit 0 ;;
      *)
        if [ "$read_status" -gt 128 ]; then
          printf "%s\n" VM0_RUNNER_LIFECYCLE_LOCK_LEASE_EXPIRED >&2
        else
          printf "VM0_RUNNER_LIFECYCLE_LOCK_READ_ERROR status=%s\n" "$read_status" >&2
        fi
        exit "$read_status"
        ;;
    esac
  done
' bash "$lease_timeout" || holder_status=$?

save_release_receipt() (
  umask 077
  install -d -m 700 -- "${receipt_path%/*}" || exit
  temporary=$(mktemp "${receipt_path}.XXXXXX") || exit
  trap 'rm -f -- "$temporary"' EXIT
  printf '%s\n' "$release_id" >"$temporary" &&
    mv -fT -- "$temporary" "$receipt_path"
)

case $holder_status in
  42)
    # flock and its child have exited. Record only explicitly requested releases.
    if ! save_release_receipt; then
      printf '%s\n' VM0_RUNNER_LIFECYCLE_LOCK_RECEIPT_UNAVAILABLE >&2
    fi
    printf '%s\n' VM0_RUNNER_LIFECYCLE_LOCK_RELEASED_AFTER_REQUEST >&2
    ;;
  0) ;;
  *)
    printf 'VM0_RUNNER_LIFECYCLE_LOCK_REMOTE_EXIT status=%s\n' "$holder_status" >&2
    exit "$holder_status"
    ;;
esac
printf '%s\n' VM0_RUNNER_LIFECYCLE_LOCK_RELEASED >&2
REMOTE
)
holder_script=${holder_script//\'/\'\\\'\'}

report_holder_result() {
  local host=$1 holder_phase=$2 holder_status=$3 error_file=$4
  local require_commit=${5:-false}
  local remote_release=unconfirmed
  if grep -Fxq VM0_RUNNER_LIFECYCLE_LOCK_RELEASED "$error_file"; then
    remote_release=confirmed
  fi
  printf 'Runner lifecycle lock: namespace=%s host=%s phase=%s local_exit=%s remote_release=%s\n' \
    "$JOB_REF" "$host" "$holder_phase" "$holder_status" "$remote_release" >&2
  # Sanitize before truncating so a cut cannot expose the suffix of a secret.
  cloudflare_ssh_sanitize_diagnostics "$error_file" | tail -c 8192 | sed 's/^/  /' >&2
  [ "$holder_status" -eq 0 ] && [ "$remote_release" = confirmed ] &&
    { ! "$require_commit" || grep -Fxq VM0_RUNNER_LIFECYCLE_LOCK_RELEASED_AFTER_REQUEST "$error_file"; }
}

confirm_release_receipt() {
  local host=$1
  # shellcheck disable=SC2029
  if timeout -k 1s 8s ssh -n "${METAL_USER}@${host}" \
    "sudo grep -Fxq -- '${release_id}' '${receipt_path}'" >/dev/null 2>&1; then
    printf 'Runner lifecycle lock: namespace=%s host=%s remote_release=reconciled\n' "$JOB_REF" "$host" >&2
    return 0
  fi
  return 1
}

close_fd() {
  local fd=$1
  if [[ "$fd" =~ ^[0-9]+$ ]]; then
    exec {fd}>&-
  fi
}

terminate_command() {
  if [[ "$command_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$command_pid" 2>/dev/null; then
    kill -TERM -- "-${command_pid}" 2>/dev/null || kill -TERM "$command_pid" 2>/dev/null || true
    wait "$command_pid" 2>/dev/null || true
  fi
  command_pid=""
}

stop_heartbeats() {
  local pid
  for pid in "${heartbeat_pids[@]}"; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  heartbeat_pids=()
}

release_locks() {
  if $locks_released; then
    return 0
  fi
  locks_released=true

  local require_commit=${1:-false}
  local index holder_status status=0
  # Heartbeat writers hold the release descriptors, so the remote holders only
  # see end-of-input once every writer is gone.
  stop_heartbeats
  for ((index = ${#lock_fds[@]} - 1; index >= 0; index--)); do
    printf 'Requesting runner lifecycle lock release: namespace=%s host=%s phase=%s\n' \
      "$JOB_REF" "${lock_hosts[$index]}" "$phase" >&2
    if "$require_commit"; then
      printf '%s\n' VM0_RUNNER_LIFECYCLE_LOCK_RELEASE >&"${lock_fds[$index]}" || true
    fi
    close_fd "${lock_fds[$index]}"
  done
  for index in "${!lock_pids[@]}"; do
    holder_status=0
    wait "${lock_pids[$index]}" || holder_status=$?
    if report_holder_result "${lock_hosts[$index]}" "$phase" "$holder_status" "${state_dir}/${index}.err" "$require_commit"; then
      continue
    fi
    if "$require_commit" && [ "$holder_status" -eq 255 ] && confirm_release_receipt "${lock_hosts[$index]}"; then
      continue
    fi
    status=1
  done
  rm -rf "$state_dir"
  return "$status"
}

# ShellCheck does not model functions invoked through traps.
# shellcheck disable=SC2317
cleanup_on_exit() {
  local status=$?
  trap - EXIT INT TERM
  terminate_command
  if ! release_locks && [ "$status" -eq 0 ]; then
    status=1
  fi
  exit "$status"
}

trap cleanup_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for host in "${hosts[@]}"; do
  index=${#lock_pids[@]}
  ready_fifo="${state_dir}/${index}.ready"
  release_fifo="${state_dir}/${index}.release"
  marker_file="${state_dir}/${index}.marker"
  error_file="${state_dir}/${index}.err"
  mkfifo "$ready_fifo" "$release_fifo"
  exec {ready_fd}<>"$ready_fifo"
  exec {release_fd}<>"$release_fifo"

  lock_path="/var/lock/vm0-runner-lifecycle-${JOB_REF}.lock"
  remote="${METAL_USER}@${host}"
  printf -v remote_command "sudo bash -c '%s' bash %s %s %s %s %s" \
    "$holder_script" "$lock_timeout" "$lock_path" "$lease_timeout" "$receipt_path" "$release_id"
  # The validated host, timeout, and lock path select the remote lock. The
  # command itself is static and receives no untrusted shell fragments.
  # shellcheck disable=SC2029
  (
    for inherited_fd in "${lock_fds[@]}"; do
      close_fd "$inherited_fd"
    done
    close_fd "$ready_fd"
    close_fd "$release_fd"
    exec ssh "$remote" "$remote_command"
  ) <"$release_fifo" >"$ready_fifo" 2>"$error_file" &
  ssh_pid=$!

  (
    for inherited_fd in "${lock_fds[@]}"; do
      close_fd "$inherited_fd"
    done
    close_fd "$release_fd"
    exec timeout "${ready_timeout}s" head -n 1
  ) <&"$ready_fd" >"$marker_file" &
  ready_pid=$!
  wait_candidates=("$ready_pid" "$ssh_pid" "${lock_pids[@]}")
  completed_pid=""
  set +e
  wait -n -p completed_pid "${wait_candidates[@]}"
  completed_status=$?
  set -e

  if [ "$completed_pid" != "$ready_pid" ] || [ "$completed_status" -ne 0 ]; then
    kill "$ready_pid" 2>/dev/null || true
    wait "$ready_pid" 2>/dev/null || true
    close_fd "$ready_fd"
    close_fd "$release_fd"
    kill "$ssh_pid" 2>/dev/null || true
    holder_status=0
    wait "$ssh_pid" 2>/dev/null || holder_status=$?
    echo "failed to acquire runner lifecycle lock on ${host}: waiter_exit=${completed_status}" >&2
    report_holder_result "$host" acquire "$holder_status" "$error_file" || true
    exit 1
  fi

  close_fd "$ready_fd"
  marker=$(cat "$marker_file")
  if [ "$marker" != "VM0_RUNNER_LIFECYCLE_LOCK_ACQUIRED" ] || ! kill -0 "$ssh_pid" 2>/dev/null; then
    close_fd "$release_fd"
    kill "$ssh_pid" 2>/dev/null || true
    holder_status=0
    wait "$ssh_pid" 2>/dev/null || holder_status=$?
    echo "runner lifecycle lock on ${host} returned an invalid acquisition marker" >&2
    report_holder_result "$host" acquire "$holder_status" "$error_file" || true
    exit 1
  fi

  rm -f "$ready_fifo" "$release_fifo" "$marker_file"

  # Start heartbeating before the next host is acquired: a lock taken early
  # must not expire while a later host is still waiting for its own lock.
  # `sleep` runs without the release descriptor so stopping this writer frees
  # the descriptor immediately.
  (
    for inherited_fd in "${lock_fds[@]}"; do
      close_fd "$inherited_fd"
    done
    heartbeat_sleep_pid=""
    trap '
      if [ -n "$heartbeat_sleep_pid" ]; then
        kill "$heartbeat_sleep_pid" 2>/dev/null || true
        wait "$heartbeat_sleep_pid" 2>/dev/null || true
      fi
    ' EXIT
    trap 'exit 0' INT TERM
    while :; do
      sleep "$heartbeat_interval" {release_fd}>&- >/dev/null 2>&1 &
      heartbeat_sleep_pid=$!
      wait "$heartbeat_sleep_pid" || exit 0
      heartbeat_sleep_pid=""
      printf '%s\n' VM0_RUNNER_LIFECYCLE_LOCK_HEARTBEAT >&"$release_fd" || exit 0
    done
  ) &
  heartbeat_pids+=("$!")

  lock_fds+=("$release_fd")
  lock_hosts+=("$host")
  lock_pids+=("$ssh_pid")
  echo "Acquired runner lifecycle lock for ${JOB_REF} on ${host}"
done

phase=running
(
  for inherited_fd in "${lock_fds[@]}"; do
    close_fd "$inherited_fd"
  done
  exec setsid --wait "$@"
) &
command_pid=$!
wait_candidates=("$command_pid" "${lock_pids[@]}")
completed_pid=""
set +e
wait -n -p completed_pid "${wait_candidates[@]}"
completed_status=$?
set -e

if [ "$completed_pid" = "$command_pid" ]; then
  command_pid=""
  command_status=$completed_status
  phase=release
else
  lost_index=""
  lost_host="an unidentified host"
  for index in "${!lock_pids[@]}"; do
    if [ "${lock_pids[$index]}" = "$completed_pid" ]; then
      lost_index=$index
      lost_host="${lock_hosts[$index]}"
    fi
  done
  echo "runner lifecycle lock on ${lost_host} was lost while the protected command was running" >&2
  if [ -n "$lost_index" ]; then
    report_holder_result "$lost_host" running "$completed_status" "${state_dir}/${lost_index}.err" || true
  fi
  terminate_command
  command_status=1
fi

require_commit=false
if [ "$phase" = release ] && [ "$command_status" -eq 0 ]; then
  require_commit=true
fi
release_status=0
release_locks "$require_commit" || release_status=$?
trap - EXIT INT TERM
if [ "$command_status" -ne 0 ]; then
  exit "$command_status"
fi
exit "$release_status"
