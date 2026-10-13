#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: $0 <scenario-name> <remote-worker> [worker-argument]" >&2
  exit 2
fi

TEST_NAME=$1
REMOTE_WORKER=$2
# The optional argument is visible in transient unit process metadata. Callers
# must keep secrets in their short configuration boundary instead.
REMOTE_WORKER_ARGUMENTS=()
if [ "$#" -eq 3 ]; then
  REMOTE_WORKER_ARGUMENTS=("$3")
fi
if [[ ! "$TEST_NAME" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo "scenario name must contain lowercase alphanumeric segments joined by hyphens" >&2
  exit 2
fi
if [ ! -f "$REMOTE_WORKER" ]; then
  echo "remote worker does not exist: $REMOTE_WORKER" >&2
  exit 2
fi

REMOTE="${METAL_USER}@${HOST}"

case "${GITHUB_RUN_ID:-}" in
  ''|*[!0-9]*)
    echo "GITHUB_RUN_ID must be numeric" >&2
    exit 2
    ;;
esac
case "${GITHUB_RUN_ATTEMPT:-}" in
  ''|*[!0-9]*)
    echo "GITHUB_RUN_ATTEMPT must be numeric" >&2
    exit 2
    ;;
esac

EXECUTION_KEY="${TEST_NAME}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
REMOTE_DIR="/tmp/vm0-runner-behavior/${EXECUTION_KEY}"
REMOTE_WORKER_PATH="${REMOTE_DIR}/worker.sh"
REMOTE_LOG="${REMOTE_DIR}/output.log"
REMOTE_STATUS="${REMOTE_DIR}/status"
REMOTE_UNIT="vm0-ci-${EXECUTION_KEY}"
SSH_ATTEMPTS=3
RESULT_POLL_SECONDS=2
RESULT_TIMEOUT_SECONDS=270

LOCAL_LOG=$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/${TEST_NAME}-result.XXXXXX")
REMOTE_STAGED=0
REMOTE_MAY_BE_STARTED=0
REMOTE_DONE=0

cleanup() {
  rm -f "$LOCAL_LOG"

  if [ "$REMOTE_STAGED" -eq 1 ]; then
    if [ "$REMOTE_MAY_BE_STARTED" -eq 1 ]; then
      if [ "$REMOTE_DONE" -eq 1 ]; then
        return
      fi
      ssh "$REMOTE" bash -s -- "$REMOTE_DIR" "$REMOTE_UNIT" <<'REMOTE_ABORT' >/dev/null 2>&1 || true
set -euo pipefail
REMOTE_DIR=$1
UNIT=$2
sudo systemctl stop "${UNIT}.service" 2>/dev/null || true
rm -rf -- "$REMOTE_DIR"
REMOTE_ABORT
    else
      # REMOTE_DIR is derived from a validated scenario and numeric workflow IDs.
      # shellcheck disable=SC2029
      ssh "$REMOTE" "rm -rf -- '${REMOTE_DIR}'" >/dev/null 2>&1 || true
    fi
  fi
}
trap cleanup EXIT

stage_worker() {
  local attempt
  local status

  for attempt in $(seq 1 "$SSH_ATTEMPTS"); do
    status=0
    # REMOTE_DIR is derived from a validated scenario and numeric workflow IDs.
    # shellcheck disable=SC2029
    ssh "$REMOTE" "set -eu
umask 077
mkdir -p '${REMOTE_DIR}'
tmp=\$(mktemp '${REMOTE_DIR}/worker.XXXXXX')
trap 'rm -f \"\$tmp\"' EXIT
cat > \"\$tmp\"
chmod 700 \"\$tmp\"
mv \"\$tmp\" '${REMOTE_WORKER_PATH}'
trap - EXIT" < "$REMOTE_WORKER" || status=$?

    if [ "$status" -eq 0 ]; then
      return 0
    fi
    if [ "$status" -ne 255 ] || [ "$attempt" -eq "$SSH_ATTEMPTS" ]; then
      return "$status"
    fi

    echo "Transient SSH failure while staging ${TEST_NAME} worker; retrying (${attempt}/${SSH_ATTEMPTS})" >&2
    sleep "$attempt"
  done
}

launch_once() {
  ssh "$REMOTE" bash -s -- \
    "$REMOTE_DIR" "$REMOTE_WORKER_PATH" "$REMOTE_LOG" "$REMOTE_STATUS" \
    "$REMOTE_UNIT" "$BIN_DIR" "$JOB_REF" \
    "${REMOTE_WORKER_ARGUMENTS[@]}" <<'REMOTE_LAUNCH'
set -euo pipefail
REMOTE_DIR=$1
WORKER=$2
LOG=$3
STATUS_FILE=$4
UNIT=$5
BIN_DIR=$6
JOB_REF=$7
WORKER_ARGUMENTS=("${@:8}")

exec 9>"${REMOTE_DIR}/launch.lock"
flock 9

if [ -f "$STATUS_FILE" ]; then
  exit 0
fi

LOAD_STATE=$(sudo systemctl show "${UNIT}.service" \
  --property=LoadState --value 2>/dev/null || true)
if [ "$LOAD_STATE" = "loaded" ]; then
  ACTIVE_STATE=$(sudo systemctl show "${UNIT}.service" \
    --property=ActiveState --value)
  case "$ACTIVE_STATE" in
    active|activating|deactivating)
      exit 0
      ;;
    *)
      if [ -f "$STATUS_FILE" ]; then
        exit 0
      fi
      echo "durable runner behavior unit stopped without publishing a result: ${ACTIVE_STATE}" >&2
      exit 1
      ;;
  esac
fi
if [ -n "$LOAD_STATE" ] && [ "$LOAD_STATE" != "not-found" ]; then
  if [ -f "$STATUS_FILE" ]; then
    exit 0
  fi
  echo "unexpected durable runner behavior unit load state: ${LOAD_STATE}" >&2
  exit 1
fi
if [ -f "$STATUS_FILE" ]; then
  exit 0
fi

REMOTE_UID=$(id -u)
REMOTE_GID=$(id -g)
REMOTE_HOME=$HOME
REMOTE_PWD=$PWD

sudo systemd-run \
  --quiet \
  --collect \
  --expand-environment=no \
  --service-type=exec \
  --unit="$UNIT" \
  --uid="$REMOTE_UID" \
  --gid="$REMOTE_GID" \
  --working-directory="$REMOTE_PWD" \
  --setenv="HOME=${REMOTE_HOME}" \
  --setenv="RUNNER_BEHAVIOR_DURABLE_UNIT=${UNIT}.service" \
  /bin/bash -c '
    worker=$1
    log=$2
    status_file=$3
    bin_dir=$4
    job_ref=$5
    shift 5

    set -euo pipefail
    worker_status=0
    "$worker" "$bin_dir" "$job_ref" "$@" > "$log" 2>&1 || worker_status=$?
    printf "%s\n" "$worker_status" > "${status_file}.tmp"
    mv "${status_file}.tmp" "$status_file"
    exit "$worker_status"
  ' runner-behavior-result-wrapper "$WORKER" "$LOG" "$STATUS_FILE" "$BIN_DIR" "$JOB_REF" \
  "${WORKER_ARGUMENTS[@]}"
REMOTE_LAUNCH
}

launch_worker() {
  local attempt
  local status

  for attempt in $(seq 1 "$SSH_ATTEMPTS"); do
    status=0
    launch_once || status=$?

    if [ "$status" -eq 0 ]; then
      return 0
    fi
    if [ "$status" -ne 255 ] || [ "$attempt" -eq "$SSH_ATTEMPTS" ]; then
      return "$status"
    fi

    echo "Lost SSH launch response; checking the same durable execution (${attempt}/${SSH_ATTEMPTS})" >&2
    sleep "$attempt"
  done
}

read_remote_state() {
  ssh "$REMOTE" bash -s -- "$REMOTE_STATUS" "$REMOTE_UNIT" <<'REMOTE_STATE'
set -euo pipefail
STATUS_FILE=$1
UNIT=$2

emit_result_if_ready() {
  if [ ! -f "$STATUS_FILE" ]; then
    return 1
  fi
  STATUS=$(<"$STATUS_FILE")
  printf 'done:%s\n' "$STATUS"
}

if emit_result_if_ready; then
  exit 0
fi

LOAD_STATE=$(sudo systemctl show "${UNIT}.service" \
  --property=LoadState --value 2>/dev/null || true)
if [ -z "$LOAD_STATE" ] || [ "$LOAD_STATE" = "not-found" ]; then
  if emit_result_if_ready; then
    exit 0
  fi
  echo "absent"
  exit 0
fi
if [ "$LOAD_STATE" != "loaded" ]; then
  if emit_result_if_ready; then
    exit 0
  fi
  printf 'invalid-load:%s\n' "$LOAD_STATE"
  exit 0
fi

ACTIVE_STATE=$(sudo systemctl show "${UNIT}.service" \
  --property=ActiveState --value)
case "$ACTIVE_STATE" in
  active|activating|deactivating)
    echo "pending"
    ;;
  *)
    if emit_result_if_ready; then
      exit 0
    fi
    printf 'stopped:%s\n' "$ACTIVE_STATE"
    ;;
esac
REMOTE_STATE
}

read_remote_state_with_retry() {
  local attempt
  local state
  local status

  for attempt in $(seq 1 "$SSH_ATTEMPTS"); do
    status=0
    state=$(read_remote_state) || status=$?

    if [ "$status" -eq 0 ]; then
      printf '%s\n' "$state"
      return 0
    fi
    if [ "$status" -ne 255 ] || [ "$attempt" -eq "$SSH_ATTEMPTS" ]; then
      return "$status"
    fi

    echo "Transient SSH failure while observing ${TEST_NAME} result; retrying (${attempt}/${SSH_ATTEMPTS})" >&2
    sleep "$attempt"
  done
}

fetch_remote_log() {
  local attempt
  local status

  for attempt in $(seq 1 "$SSH_ATTEMPTS"); do
    status=0
    # REMOTE_LOG is derived from a validated scenario and numeric workflow IDs.
    # shellcheck disable=SC2029
    ssh "$REMOTE" "cat -- '${REMOTE_LOG}'" > "$LOCAL_LOG" || status=$?

    if [ "$status" -eq 0 ]; then
      return 0
    fi
    if [ "$status" -ne 255 ] || [ "$attempt" -eq "$SSH_ATTEMPTS" ]; then
      return "$status"
    fi

    echo "Transient SSH failure while retrieving ${TEST_NAME} log; retrying (${attempt}/${SSH_ATTEMPTS})" >&2
    sleep "$attempt"
  done
}

remove_remote_result() {
  ssh "$REMOTE" bash -s -- "$REMOTE_DIR" "$REMOTE_UNIT" <<'REMOTE_REMOVE'
set -euo pipefail
REMOTE_DIR=$1
UNIT=$2

for _ in $(seq 1 20); do
  LOAD_STATE=$(sudo systemctl show "${UNIT}.service" \
    --property=LoadState --value 2>/dev/null || true)
  if [ -z "$LOAD_STATE" ] || [ "$LOAD_STATE" = "not-found" ]; then
    rm -rf -- "$REMOTE_DIR"
    exit 0
  fi
  sleep 0.25
done

echo "durable runner behavior unit was not collected" >&2
exit 1
REMOTE_REMOVE
}

remove_remote_result_with_retry() {
  local attempt
  local status

  for attempt in $(seq 1 "$SSH_ATTEMPTS"); do
    status=0
    remove_remote_result || status=$?

    if [ "$status" -eq 0 ]; then
      return 0
    fi
    if [ "$status" -ne 255 ] || [ "$attempt" -eq "$SSH_ATTEMPTS" ]; then
      return "$status"
    fi

    echo "Transient SSH failure while removing ${TEST_NAME} result; retrying (${attempt}/${SSH_ATTEMPTS})" >&2
    sleep "$attempt"
  done
}

echo "=== Staging durable ${TEST_NAME} test ==="
REMOTE_STAGED=1
stage_worker

echo "=== Running ${TEST_NAME} test ==="
REMOTE_MAY_BE_STARTED=1
launch_worker

DEADLINE=$(( SECONDS + RESULT_TIMEOUT_SECONDS ))
POLL_COUNT=0
REMOTE_RESULT=""
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  STATE=$(read_remote_state_with_retry)
  case "$STATE" in
    done:*)
      REMOTE_RESULT=${STATE#done:}
      REMOTE_DONE=1
      break
      ;;
    pending)
      POLL_COUNT=$(( POLL_COUNT + 1 ))
      if [ "$POLL_COUNT" -eq 1 ] || [ $(( POLL_COUNT % 15 )) -eq 0 ]; then
        echo "Waiting for durable ${TEST_NAME} result"
      fi
      ;;
    absent)
      if fetch_remote_log; then
        cat "$LOCAL_LOG"
      fi
      echo "durable ${TEST_NAME} unit disappeared without publishing a result" >&2
      exit 1
      ;;
    stopped:*)
      if fetch_remote_log; then
        cat "$LOCAL_LOG"
      fi
      echo "durable ${TEST_NAME} unit stopped without publishing a result: ${STATE#stopped:}" >&2
      exit 1
      ;;
    invalid-load:*)
      if fetch_remote_log; then
        cat "$LOCAL_LOG"
      fi
      echo "unexpected durable ${TEST_NAME} unit load state: ${STATE#invalid-load:}" >&2
      exit 1
      ;;
    *)
      echo "unexpected durable ${TEST_NAME} state: $STATE" >&2
      exit 1
      ;;
  esac
  sleep "$RESULT_POLL_SECONDS"
done

if [ -z "$REMOTE_RESULT" ]; then
  echo "durable ${TEST_NAME} test did not finish within ${RESULT_TIMEOUT_SECONDS}s" >&2
  if fetch_remote_log; then
    cat "$LOCAL_LOG"
  fi
  exit 1
fi

case "$REMOTE_RESULT" in
  ''|*[!0-9]*)
    echo "invalid durable ${TEST_NAME} exit status: $REMOTE_RESULT" >&2
    exit 1
    ;;
esac
if [ "$REMOTE_RESULT" -gt 255 ]; then
  echo "invalid durable ${TEST_NAME} exit status: $REMOTE_RESULT" >&2
  exit 1
fi

fetch_remote_log
cat "$LOCAL_LOG"
remove_remote_result_with_retry
REMOTE_STAGED=0

# Preserve the worker status as the script's final command while still allowing
# ShellCheck to analyze the EXIT trap handler.
(exit "$REMOTE_RESULT")
