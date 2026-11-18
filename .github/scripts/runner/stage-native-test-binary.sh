#!/usr/bin/env bash
set -euo pipefail

# Stage one immutable native test executable; never submit the test itself.
# Usage: stage-native-test-binary.sh <local-executable> <user@host> </tmp/path>
# Requires Bash, GNU timeout, ssh, sha256sum and remote mktemp/coreutils.
# Three transfer attempts (120s each) fit inside one 400s owner deadline.
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
cleanup() {
  local status=$?
  trap - EXIT
  trap '' INT TERM HUP
  if [ -n "$child" ]; then
    kill -TERM -- "-$child" 2>/dev/null || kill -TERM "$child" 2>/dev/null || true
    # A guarded SSH caller may need its own five-second cancellation cleanup.
    sleep 5
    kill -KILL -- "-$child" 2>/dev/null || kill -KILL "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

for attempt in 1 2 3; do
  status=0
  echo "Native binary staging: host=${remote#*@} attempt=${attempt}/3" >&2
  timeout --verbose --kill-after=5s 120s \
    ssh "$remote" "$remote_command" <"$source_file" &
  child=$!
  wait "$child" || status=$?
  child=""
  if [ "$status" -eq 0 ]; then
    exit 0
  fi
  case "$status" in
    124 | 141 | 255) ;;
    *) exit "$status" ;;
  esac
  if [ "$attempt" -eq 3 ]; then
    exit "$status"
  fi
  echo "Native binary staging interrupted: exit=${status}; retrying verified staging" >&2
  sleep "$attempt" &
  child=$!
  wait "$child"
  child=""
done
