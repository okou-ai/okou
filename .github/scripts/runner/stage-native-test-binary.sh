#!/usr/bin/env bash
set -euo pipefail

# Stage one immutable native test executable; never submit the test itself.
# Usage: stage-native-test-binary.sh <local-executable> <user@host> </tmp/path>
# Requires Bash, GNU timeout, ssh, sha256sum and remote mktemp/coreutils.
# Transfer retries share one 400s owner deadline.
if [ "${1:-}" != --bounded ]; then
  exec timeout --verbose --kill-after=10s 400s bash "$0" --bounded "$@"
fi
shift
if [ "$#" -ne 3 ]; then
  echo "usage: $0 <local-executable> <user@host> </tmp/path>" >&2
  exit 2
fi
source_file=$1 remote=$2 destination=$3
if [ ! -f "$source_file" ] || [ ! -x "$source_file" ] ||
  [[ ! "$remote" =~ ^[A-Za-z_][A-Za-z0-9_-]*@[A-Za-z0-9][A-Za-z0-9.-]*$ ]] ||
  [[ ! "$destination" =~ ^/tmp/[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "invalid native test binary staging input" >&2
  exit 2
fi
expected_sha=$(sha256sum <"$source_file")
expected_sha=${expected_sha%% *}
source_size=$(stat -Lc %s -- "$source_file")

# Every submission creates its own writer. A disconnected previous writer can
# publish only the same verified bytes, never a partial later execution input.
remote_script=$(
  cat <<'REMOTE_SCRIPT'
set -euo pipefail
destination=$1
expected_sha=$2
umask 077
candidate=$(mktemp "${destination}.upload.XXXXXX")
cleanup_candidate() { rm -f -- "$candidate"; }
trap cleanup_candidate EXIT
cat > "$candidate"
actual_sha=$(sha256sum -- "$candidate")
actual_sha=${actual_sha%% *}
if [ "$actual_sha" != "$expected_sha" ]; then
  echo "native test binary checksum mismatch" >&2
  exit 1
fi
chmod 755 "$candidate"
mv -fT -- "$candidate" "$destination"
REMOTE_SCRIPT
)
# SSH first passes this through the account's login shell. The static program
# contains no single quotes; validated path/hash operands cannot contain them.
printf -v remote_command "bash -c '%s' native-test-stage '%s' '%s'" \
  "$remote_script" "$destination" "$expected_sha"

child=""
chunk_file=""
remote_stage=""
cleanup() {
  local status=$?
  local pid
  local -a children=()
  trap - EXIT
  trap '' INT TERM HUP
  if [ -n "$child" ]; then
    children+=("$child")
  fi
  # Include a child launched immediately before a signal, before $! was saved.
  for pid in $(jobs -pr); do
    children+=("$pid")
  done
  if [ "${#children[@]}" -gt 0 ]; then
    for pid in "${children[@]}"; do
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    done
    # A guarded SSH caller may need its own five-second cancellation cleanup.
    sleep 5
    for pid in "${children[@]}"; do
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    done
  fi
  if [ -n "$chunk_file" ]; then
    rm -f -- "$chunk_file"
  fi
  if [ -n "$remote_stage" ]; then
    timeout --kill-after=5s 5s ssh -n "$remote" "rm -rf -- '$remote_stage'" >&2 ||
      echo "Native binary staging cleanup unconfirmed for ${remote#*@}" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

transfer() {
  local command=$1 input=$2 attempt status
  for attempt in 1 2 3; do
    status=0
    echo "Native binary staging: host=${remote#*@} attempt=${attempt}/3" >&2
    # Guarded SSH spends five seconds retiring its caller after TERM. Let it
    # finish before forced KILL changes a retryable deadline into exit 137.
    timeout --verbose --kill-after=10s 120s \
      ssh "$remote" "$command" <"$input" &
    child=$!
    wait "$child" || status=$?
    child=""
    if [ "$status" -eq 0 ]; then
      return 0
    fi
    case "$status" in
      124 | 141 | 255) ;;
      *) return "$status" ;;
    esac
    if [ "$attempt" -eq 3 ]; then
      return "$status"
    fi
    echo "Native binary staging interrupted: exit=${status}; retrying verified staging" >&2
    sleep "$attempt" &
    child=$!
    wait "$child"
    child=""
  done
}

# Keep the one-request path for smaller inputs. Large binaries have failed
# repeatedly after transferring substantial prefixes of the same executable.
chunk_size=$((64 * 1024 * 1024))
if [ "$source_size" -le "$((2 * chunk_size))" ]; then
  transfer "$remote_command" "$source_file"
  exit
fi

# The job owns a unique private stage. A retry can only replace a chunk with
# the same verified bytes. Only finalization can publish the executable.
IFS= read -r stage_id </proc/sys/kernel/random/uuid
remote_stage="${destination}.upload.${stage_id}"
chunk_file=$(mktemp)
chunk_script=$(cat <<'REMOTE_SCRIPT'
set -euo pipefail
stage=$1 index=$2 expected=$3
umask 077
candidate=$(mktemp "${stage}/partial.XXXXXX")
trap "rm -f -- \"\$candidate\"" EXIT
cat > "$candidate"
actual=$(sha256sum < "$candidate")
[ "${actual%% *}" = "$expected" ] || { echo "native test chunk checksum mismatch" >&2; exit 1; }
mv -fT -- "$candidate" "${stage}/chunk.${index}"
REMOTE_SCRIPT
)
publish_script=$(cat <<'REMOTE_SCRIPT'
set -euo pipefail
stage=$1 destination=$2 expected=$3 count=$4
umask 077
candidate=$(mktemp "${stage}/result.XXXXXX")
trap "rm -f -- \"\$candidate\"" EXIT
for ((index=0; index<count; index++)); do
  cat -- "${stage}/chunk.${index}"
done > "$candidate"
actual=$(sha256sum < "$candidate")
[ "${actual%% *}" = "$expected" ] || { echo "native test binary checksum mismatch" >&2; exit 1; }
chmod 755 "$candidate"
mv -fT -- "$candidate" "$destination"
REMOTE_SCRIPT
)
transfer "umask 077; mkdir -m 700 -- '$remote_stage' || { test -d '$remote_stage' && test -O '$remote_stage' && test ! -L '$remote_stage'; }" /dev/null
chunk_count=$(((source_size + chunk_size - 1) / chunk_size))
for ((index=0; index<chunk_count; index++)); do
  printf 'Native binary staging chunk %s/%s\n' "$((index + 1))" "$chunk_count" >&2
  dd if="$source_file" of="$chunk_file" bs="$chunk_size" skip="$index" count=1 status=none
  chunk_sha=$(sha256sum <"$chunk_file")
  printf -v upload_command "bash -c '%s' native-chunk '%s' '%s' '%s'" \
    "$chunk_script" "$remote_stage" "$index" "${chunk_sha%% *}"
  transfer "$upload_command" "$chunk_file"
done
printf -v publish_command "bash -c '%s' native-publish '%s' '%s' '%s' '%s'" \
  "$publish_script" "$remote_stage" "$destination" "$expected_sha" "$chunk_count"
transfer "$publish_command" /dev/null
