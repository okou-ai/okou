#!/usr/bin/env bash
set -euo pipefail

TOOL=$(basename "$0")
case "$TOOL" in
  ssh)
    REAL_BINARY="${OKOU_CLOUDFLARE_SSH_REAL_SSH:-}"
    ;;
  scp)
    REAL_BINARY="${OKOU_CLOUDFLARE_SSH_REAL_SCP:-}"
    ;;
  sftp)
    REAL_BINARY="${OKOU_CLOUDFLARE_SSH_REAL_SFTP:-}"
    ;;
  *)
    echo "Unsupported Cloudflare SSH command: ${TOOL}" >&2
    exit 2
    ;;
esac

if [ -z "$REAL_BINARY" ] || [ ! -x "$REAL_BINARY" ]; then
  echo "Missing real ${TOOL} binary for Cloudflare SSH transport" >&2
  exit 2
fi

ORIGINAL_ARGS=("$@")
BYPASS=false
DESTINATION=""
TARGET_USER=""
TARGET_USER_EXPLICIT=false
TARGET_HOST=""
REMOTE_OPERAND_COUNT=0
OPERANDS=()

# Recognize only the repository's native and Ansible invocation shapes.
# Unknown transport-changing forms must reach the real client unchanged.
strip_wrapping_quotes() {
  local value=$1
  if [[ "$value" == \"*\" ]] && [ "${#value}" -ge 2 ]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

parse_supported_ssh_option() {
  local option=$1
  local key value normalized_value
  if [[ "$option" != *=* ]]; then
    BYPASS=true
    return
  fi

  key="${option%%=*}"
  value="${option#*=}"
  case "${key,,}" in
    user)
      TARGET_USER=$(strip_wrapping_quotes "$value")
      TARGET_USER_EXPLICIT=true
      ;;
    controlmaster)
      normalized_value=$(strip_wrapping_quotes "$value")
      if [ "${normalized_value,,}" != "auto" ]; then
        BYPASS=true
      fi
      ;;
    controlpath)
      normalized_value=$(strip_wrapping_quotes "$value")
      if [ "$normalized_value" != \
        "${OKOU_CLOUDFLARE_SSH_DEFAULT_CONTROL_PATH:-}" ]; then
        BYPASS=true
      fi
      ;;
    batchmode|challengeresponseauthentication|connecttimeout|controlpersist|hostkeyalias|kbdinteractiveauthentication|loglevel|passwordauthentication|preferredauthentications|serveralivecountmax|serveraliveinterval|stricthostkeychecking|tcpkeepalive|userknownhostsfile)
      ;;
    *)
      BYPASS=true
      ;;
  esac
}

parse_ssh_arguments() {
  local index=0
  local argument

  while [ "$index" -lt "${#ORIGINAL_ARGS[@]}" ]; do
    argument="${ORIGINAL_ARGS[$index]}"
    case "$argument" in
      --)
        index=$((index + 1))
        if [ "$index" -lt "${#ORIGINAL_ARGS[@]}" ]; then
          DESTINATION="${ORIGINAL_ARGS[$index]}"
        fi
        return
        ;;
      -l)
        index=$((index + 1))
        if [ "$index" -ge "${#ORIGINAL_ARGS[@]}" ]; then
          BYPASS=true
          return
        fi
        TARGET_USER=$(strip_wrapping_quotes "${ORIGINAL_ARGS[$index]}")
        TARGET_USER_EXPLICIT=true
        ;;
      -l?*)
        TARGET_USER=$(strip_wrapping_quotes "${argument#-l}")
        TARGET_USER_EXPLICIT=true
        ;;
      -o)
        index=$((index + 1))
        if [ "$index" -ge "${#ORIGINAL_ARGS[@]}" ]; then
          BYPASS=true
          return
        fi
        parse_supported_ssh_option "${ORIGINAL_ARGS[$index]}"
        if [ "$BYPASS" = "true" ]; then
          return
        fi
        ;;
      -o?*)
        parse_supported_ssh_option "${argument#-o}"
        if [ "$BYPASS" = "true" ]; then
          return
        fi
        ;;
      -O|-O?*|-Q|-Q?*|-S|-S?*|-W|-W?*)
        BYPASS=true
        return
        ;;
      -*)
        if [[ "$argument" =~ ^-[46AaCfKknqsTtVvXxYy]+$ ]]; then
          if [[ "$argument" == *V* ]]; then
            BYPASS=true
            return
          fi
        else
          BYPASS=true
          return
        fi
        ;;
      *)
        DESTINATION="$argument"
        return
        ;;
    esac
    index=$((index + 1))
  done
}

parse_scp_arguments() {
  local index=0
  local argument

  while [ "$index" -lt "${#ORIGINAL_ARGS[@]}" ]; do
    argument="${ORIGINAL_ARGS[$index]}"
    case "$argument" in
      --)
        index=$((index + 1))
        break
        ;;
      -o)
        index=$((index + 1))
        if [ "$index" -ge "${#ORIGINAL_ARGS[@]}" ]; then
          BYPASS=true
          return
        fi
        parse_supported_ssh_option "${ORIGINAL_ARGS[$index]}"
        if [ "$BYPASS" = "true" ]; then
          return
        fi
        ;;
      -o?*)
        parse_supported_ssh_option "${argument#-o}"
        if [ "$BYPASS" = "true" ]; then
          return
        fi
        ;;
      -[346ABCOpqRrsTv]*)
        if [[ ! "$argument" =~ ^-[346ABCOpqRrsTv]+$ ]]; then
          BYPASS=true
          return
        fi
        ;;
      -*)
        BYPASS=true
        return
        ;;
      *)
        break
        ;;
    esac
    index=$((index + 1))
  done

  while [ "$index" -lt "${#ORIGINAL_ARGS[@]}" ]; do
    OPERANDS+=("${ORIGINAL_ARGS[$index]}")
    index=$((index + 1))
  done
}

parse_sftp_arguments() {
  local index=0
  local argument

  while [ "$index" -lt "${#ORIGINAL_ARGS[@]}" ]; do
    argument="${ORIGINAL_ARGS[$index]}"
    case "$argument" in
      --)
        index=$((index + 1))
        if [ "$index" -lt "${#ORIGINAL_ARGS[@]}" ]; then
          DESTINATION="${ORIGINAL_ARGS[$index]}"
        fi
        return
        ;;
      -o)
        index=$((index + 1))
        if [ "$index" -ge "${#ORIGINAL_ARGS[@]}" ]; then
          BYPASS=true
          return
        fi
        parse_supported_ssh_option "${ORIGINAL_ARGS[$index]}"
        if [ "$BYPASS" = "true" ]; then
          return
        fi
        ;;
      -o?*)
        parse_supported_ssh_option "${argument#-o}"
        if [ "$BYPASS" = "true" ]; then
          return
        fi
        ;;
      -b|-B|-R|-X)
        index=$((index + 1))
        if [ "$index" -ge "${#ORIGINAL_ARGS[@]}" ]; then
          BYPASS=true
          return
        fi
        ;;
      -b?*|-B?*|-R?*|-X?*)
        ;;
      -[46AaCfpqrv]*)
        if [[ ! "$argument" =~ ^-[46AaCfpqrv]+$ ]]; then
          BYPASS=true
          return
        fi
        ;;
      -*)
        BYPASS=true
        return
        ;;
      *)
        DESTINATION="$argument"
        return
        ;;
    esac
    index=$((index + 1))
  done
}

record_remote_authority() {
  local authority=$1
  local parsed_user=""
  local parsed_host="$authority"

  if [[ "$parsed_host" == *@* ]]; then
    parsed_user="${parsed_host%@*}"
    parsed_host="${parsed_host##*@}"
  fi

  REMOTE_OPERAND_COUNT=$((REMOTE_OPERAND_COUNT + 1))
  if [ "$parsed_host" != "${parsed_host,,}" ]; then
    BYPASS=true
    return
  fi
  if [[ ! "$parsed_host" =~ ^[a-z0-9][a-z0-9.-]*\.vm3\.ai$ ]]; then
    BYPASS=true
    return
  fi
  if [ -n "$TARGET_HOST" ] && [ "$TARGET_HOST" != "$parsed_host" ]; then
    BYPASS=true
    return
  fi
  if [ -n "$parsed_user" ] \
    && [ -n "$TARGET_USER" ] \
    && [ "$TARGET_USER" != "$parsed_user" ]; then
    BYPASS=true
    return
  fi

  TARGET_HOST="$parsed_host"
  if [ -n "$parsed_user" ]; then
    TARGET_USER="$parsed_user"
    TARGET_USER_EXPLICIT=true
  fi
}

record_uri_destination() {
  local destination=$1
  local authority="${destination#*://}"
  local host
  authority="${authority%%/*}"
  host="${authority##*@}"
  if [[ "$host" == *:* ]]; then
    BYPASS=true
    return
  fi
  record_remote_authority "$authority"
}

record_ssh_destination() {
  local destination=$1
  if [[ "$destination" == ssh://* ]]; then
    record_uri_destination "$destination"
  else
    record_remote_authority "$destination"
  fi
}

record_copy_operand() {
  local operand=$1
  local authority

  if [[ "$operand" == scp://* || "$operand" == sftp://* ]]; then
    record_uri_destination "$operand"
    return
  fi
  if [[ "$operand" != *:* ]]; then
    return
  fi

  authority="${operand%%:*}"
  if [[ "$authority" == */* ]]; then
    return
  fi
  record_remote_authority "$authority"
}

case "$TOOL" in
  ssh)
    parse_ssh_arguments
    if [ -n "$DESTINATION" ]; then
      record_ssh_destination "$DESTINATION"
    fi
    ;;
  scp)
    parse_scp_arguments
    for operand in "${OPERANDS[@]}"; do
      record_copy_operand "$operand"
    done
    if [ "$REMOTE_OPERAND_COUNT" -ne 1 ]; then
      BYPASS=true
    fi
    ;;
  sftp)
    parse_sftp_arguments
    if [ -n "$DESTINATION" ]; then
      if [[ "$DESTINATION" == *:* ]]; then
        record_copy_operand "$DESTINATION"
      else
        record_ssh_destination "$DESTINATION"
      fi
    fi
    if [ "$REMOTE_OPERAND_COUNT" -ne 1 ]; then
      BYPASS=true
    fi
    ;;
esac

if [ -z "$TARGET_USER" ]; then
  TARGET_USER="${OKOU_CLOUDFLARE_SSH_USER:-}"
fi
if [[ ! "$TARGET_USER" =~ ^[A-Za-z0-9._-]+$ ]]; then
  BYPASS=true
fi

if [ "$BYPASS" = "true" ] || [ -z "$TARGET_HOST" ]; then
  exec "$REAL_BINARY" "${ORIGINAL_ARGS[@]}"
fi

STATE_DIR="${OKOU_CLOUDFLARE_SSH_STATE_DIR:-}"
SCRIPTS_DIR="${OKOU_CLOUDFLARE_SSH_SCRIPTS_DIR:-}"
REAL_SSH="${OKOU_CLOUDFLARE_SSH_REAL_SSH:-}"
if [[ "$STATE_DIR" != /* ]] \
  || [ ! -d "$STATE_DIR" ] \
  || [[ "$SCRIPTS_DIR" != /* ]] \
  || [ ! -d "$SCRIPTS_DIR" ] \
  || [ -z "$REAL_SSH" ] \
  || [ ! -x "$REAL_SSH" ]; then
  echo "Cloudflare SSH transport wrapper is not configured" >&2
  exit 2
fi

# shellcheck source=.github/scripts/runner/cloudflare-ssh-diagnostics.sh
. "${SCRIPTS_DIR}/cloudflare-ssh-diagnostics.sh"

PROBE_TIMEOUT_SECONDS=20
PROBE_KILL_AFTER_SECONDS=5
CONTROL_TIMEOUT_SECONDS=5
CONTROL_KILL_AFTER_SECONDS=2
OPERATION_TIMEOUT_SECONDS="${OKOU_CLOUDFLARE_SSH_OPERATION_TIMEOUT_SECONDS:-600}"
OPERATION_KILL_AFTER_SECONDS=5

if [[ ! "$OPERATION_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid Cloudflare SSH operation timeout: ${OPERATION_TIMEOUT_SECONDS}" >&2
  exit 2
fi

caller_events=()
caller_started_cs=""
selected_master_id=unselected
caller_id="${BASHPID}-${EPOCHREALTIME:-unavailable}"

caller_event() {
  local event=$1 status=${2:-unknown} uptime=unavailable current_cs elapsed_cs=unavailable utc
  if [ -r /proc/uptime ]; then
    read -r uptime _ < /proc/uptime || uptime=unavailable
  fi
  if [[ "$uptime" =~ ^([0-9]+)\.([0-9]{2})$ ]]; then
    current_cs=$((10#${BASH_REMATCH[1]} * 100 + 10#${BASH_REMATCH[2]}))
    if [ -z "$caller_started_cs" ]; then
      caller_started_cs=$current_cs
    fi
    elapsed_cs=$((current_cs - caller_started_cs))
  fi
  utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) || utc=unavailable
  caller_events+=("event=${event} utc=${utc} epoch=${EPOCHREALTIME:-unavailable} uptime_seconds=${uptime} elapsed_centiseconds=${elapsed_cs} call=${caller_id} tool=${TOOL} master=${selected_master_id} status=${status}")
}

emit_caller_events() {
  printf '%s\n' '----- Client operation phases (source event times) -----' >&2
  printf '%s\n' "${caller_events[@]}" >&2
}

is_transient_probe_status() {
  local status=$1
  case "$status" in
    124|137|255)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

emit_probe_failure() {
  local attempt=$1
  local status=$2
  local diagnostics_file=$3
  local annotation=$4
  local master_diagnostics_file=${5:-}

  echo "::${annotation} title=Cloudflare SSH command-channel probe failed::Unable to open a command channel to ${TARGET_HOST} on attempt ${attempt}/2 (exit ${status})" >&2
  emit_caller_events || true
  if [ -s "$diagnostics_file" ]; then
    echo "----- SSH command-channel probe stderr (last 20 lines, redacted) -----" >&2
    cloudflare_ssh_sanitize_diagnostics "$diagnostics_file" \
      | tail -n 20 >&2
  fi
  if [ -n "$master_diagnostics_file" ]; then
    cloudflare_ssh_emit_master_diagnostics "$master_diagnostics_file" || true
  fi
}

probe_transport() {
  local control_path=$1
  local diagnostics_file=$2
  local master_diagnostics_file diagnostics_offset probe_status=0
  local -a control_args=()
  if [ -n "$control_path" ]; then
    control_args=(-S "$control_path")
  fi

  (
    umask 077
    master_diagnostics_file=$(cloudflare_ssh_master_diagnostics_file \
      "$TARGET_USER" "$TARGET_HOST" "$control_path") || exit
    : >> "$master_diagnostics_file" || exit
    chmod 600 "$master_diagnostics_file" || exit
    diagnostics_offset=$(wc -c < "$master_diagnostics_file") || exit
    # A probe can create a detached master. Give every invocation the same
    # append-only stderr destination so later callers can read that master's
    # messages too. Classify only bytes added during this probe.
    OKOU_CLOUDFLARE_SSH_PROXY_DIAGNOSTICS_DIR="${master_diagnostics_file}.proxies" \
      GITHUB_STEP_SUMMARY="" \
      timeout \
        --kill-after="${PROBE_KILL_AFTER_SECONDS}s" \
        "${PROBE_TIMEOUT_SECONDS}s" \
        "$REAL_SSH" "${control_args[@]}" -v -n -T \
        "${TARGET_USER}@${TARGET_HOST}" true \
        </dev/null > /dev/null 2>> "$master_diagnostics_file" \
      || probe_status=$?
    tail -c "+$((diagnostics_offset + 1))" "$master_diagnostics_file" \
      > "$diagnostics_file" || exit
    exit "$probe_status"
  )
}

close_transport() {
  local control_path=$1
  timeout \
    --kill-after="${CONTROL_KILL_AFTER_SECONDS}s" \
    "${CONTROL_TIMEOUT_SECONDS}s" \
    "$REAL_SSH" -S "$control_path" -n -O exit \
    "${TARGET_USER}@${TARGET_HOST}"
}

target_key=$(printf '%s@%s' "$TARGET_USER" "$TARGET_HOST" \
  | sha256sum | cut -c1-24)
state_file="${STATE_DIR}/${target_key}.control-path"
lock_file="${STATE_DIR}/${target_key}.lock"

exec {lock_fd}> "$lock_file"
flock "$lock_fd"
lock_held=true

release_transport_lock() {
  if [ "$lock_held" = "true" ]; then
    flock -u "$lock_fd" || true
    lock_held=false
  fi
}
trap release_transport_lock EXIT

current_control_path=""
if [ -s "$state_file" ]; then
  IFS= read -r current_control_path < "$state_file"
  if [[ "$current_control_path" != /* ]]; then
    echo "Invalid saved Cloudflare SSH control path" >&2
    release_transport_lock
    exit 2
  fi
fi

probe_dir=$(mktemp -d "${STATE_DIR}/${target_key}.probe.XXXXXX")
first_probe_stderr="${probe_dir}/attempt-1.stderr"
probe_status=0
master_diagnostics_file=$(cloudflare_ssh_master_diagnostics_file \
  "$TARGET_USER" "$TARGET_HOST" "$current_control_path")
selected_master_id=$(printf '%s' "$master_diagnostics_file" | sha256sum | cut -c1-24)
caller_event probe-start
probe_transport "$current_control_path" "$first_probe_stderr" \
  || probe_status=$?
caller_event probe-result "$probe_status"

selected_control_path="$current_control_path"
if [ "$probe_status" -ne 0 ]; then
  if ! is_transient_probe_status "$probe_status" \
    || cloudflare_ssh_is_permanent_failure "$first_probe_stderr"; then
    emit_probe_failure \
      1 "$probe_status" "$first_probe_stderr" error \
      "$master_diagnostics_file"
    rm -rf "$probe_dir"
    release_transport_lock
    exit "$probe_status"
  fi

  emit_probe_failure \
    1 "$probe_status" "$first_probe_stderr" warning \
    "$master_diagnostics_file"
  # OpenSSH appends a temporary suffix while binding a control socket. Keep
  # this directory name short enough for Linux's Unix socket path limit.
  recovery_dir=$(mktemp -d "${STATE_DIR}/r.XXXXXX")
  recovery_control_path="${recovery_dir}/master.sock"
  recovery_status=0
  selected_master_id=$(printf '%s' "${recovery_control_path}.stderr" | sha256sum | cut -c1-24)
  caller_event recovery-start
  CLOUDFLARE_SSH_BIN="$REAL_SSH" \
    "${SCRIPTS_DIR}/cloudflare-ssh-preconnect.sh" \
    --control-path "$recovery_control_path" \
    "$TARGET_USER" "$TARGET_HOST" \
    >&2 || recovery_status=$?
  caller_event recovery-result "$recovery_status"
  if [ "$recovery_status" -ne 0 ]; then
    emit_caller_events || true
    rm -rf "$probe_dir"
    # A failed/closed proxy's native evidence still belongs to this job.
    if [ ! -d "${recovery_control_path}.stderr.proxies" ]; then
      rm -rf "$recovery_dir"
    fi
    release_transport_lock
    exit "$recovery_status"
  fi

  second_probe_stderr="${probe_dir}/attempt-2.stderr"
  probe_status=0
  caller_event probe-start
  probe_transport "$recovery_control_path" "$second_probe_stderr" \
    || probe_status=$?
  caller_event probe-result "$probe_status"
  if [ "$probe_status" -ne 0 ]; then
    emit_probe_failure \
      2 "$probe_status" "$second_probe_stderr" error \
      "${recovery_control_path}.stderr"
    close_status=0
    close_transport "$recovery_control_path" \
      > /dev/null 2>&1 || close_status=$?
    rm -rf "$probe_dir"
    if [ "$close_status" -eq 0 ] \
      && [ ! -d "${recovery_control_path}.stderr.proxies" ]; then
      rm -rf "$recovery_dir"
    fi
    release_transport_lock
    exit "$probe_status"
  fi

  selected_control_path="$recovery_control_path"
  master_diagnostics_file=$(cloudflare_ssh_master_diagnostics_file \
    "$TARGET_USER" "$TARGET_HOST" "$selected_control_path")
  state_file_tmp=$(mktemp "${state_file}.tmp.XXXXXX")
  printf '%s\n' "$selected_control_path" > "$state_file_tmp"
  mv "$state_file_tmp" "$state_file"
fi
caller_event transport-selected 0

rm -rf "$probe_dir"
release_transport_lock
trap - EXIT

# From this point the caller operation is single-shot. Never infer replay
# safety from the real client's result.
connection_args=()
if [ "$TARGET_USER_EXPLICIT" = "false" ]; then
  connection_args=(-o "User=${TARGET_USER}")
fi
if [ -n "$selected_control_path" ]; then
  connection_args+=(
    -o "ControlPath=${selected_control_path}"
  )
fi

operation_pid=""
cleanup_pid=""
operation_signal=none
operation_signal_epoch=unavailable
operation_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
caller_event caller-start
# GNU timeout creates a separate process group for the caller. Keep this shell
# alive so GitHub cancellation can terminate that group and its ProxyCommand.
trap '
  trap - EXIT
  trap "" HUP INT TERM

  if [ "$operation_signal" != none ]; then
    caller_event caller-signal "$operation_signal" || true
    printf "Cloudflare SSH caller signal: tool=%s host=%s signal=%s epoch=%s utc=%s\n" \
      "$TOOL" "$TARGET_HOST" "$operation_signal" "$operation_signal_epoch" \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2 || true
  fi
  cleanup_pid=$operation_pid
  if [ -z "$cleanup_pid" ]; then
    cleanup_pid=$!
  fi
  if [ -n "$cleanup_pid" ]; then
    kill -TERM -- "-${cleanup_pid}" 2>/dev/null || true
    sleep "$OPERATION_KILL_AFTER_SECONDS"
    kill -KILL -- "-${cleanup_pid}" 2>/dev/null || true
    wait "$cleanup_pid" 2>/dev/null || true
  fi
  if [ "$operation_signal" != none ]; then
    emit_caller_events || true
    cloudflare_ssh_emit_master_diagnostics "$master_diagnostics_file" || true
  fi
' EXIT
trap 'operation_signal=HUP; operation_signal_epoch=${EPOCHREALTIME:-unavailable}; exit 129' HUP
trap 'operation_signal=INT; operation_signal_epoch=${EPOCHREALTIME:-unavailable}; exit 130' INT
trap 'operation_signal=TERM; operation_signal_epoch=${EPOCHREALTIME:-unavailable}; exit 143' TERM

OKOU_CLOUDFLARE_SSH_PROXY_DIAGNOSTICS_DIR="${master_diagnostics_file}.proxies" \
  timeout \
  --verbose \
  --kill-after="${OPERATION_KILL_AFTER_SECONDS}s" \
  "${OPERATION_TIMEOUT_SECONDS}s" \
  "$REAL_BINARY" "${connection_args[@]}" "${ORIGINAL_ARGS[@]}" <&0 &
operation_pid=$!
operation_status=0
wait "$operation_pid" || operation_status=$?
caller_event caller-result "$operation_status"
trap - EXIT HUP INT TERM
operation_pid=""
if [ "$operation_status" -ne 0 ]; then
  # A failed caller may have executed remotely. Diagnostics must neither
  # reconnect nor replay it, and must not change its stdout or exit status.
  {
    echo "::group::Cloudflare SSH caller diagnostics" >&2
    echo "Tool: ${TOOL}; host: ${TARGET_HOST}; exit: ${operation_status}; started: ${operation_started_at}; finished: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
    echo "Run: ${GITHUB_RUN_ID:-unavailable}; attempt: ${GITHUB_RUN_ATTEMPT:-unavailable}; call: ${caller_id}; master: ${selected_master_id}" >&2
    emit_caller_events
    cloudflare_ssh_emit_master_diagnostics "$master_diagnostics_file"
    echo "::endgroup::" >&2
  } || true
fi
exit "$operation_status"
