#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
lock_script="${repo_root}/.github/scripts/runner/with-runner-lifecycle-lock.sh"
tmp_dir=$(mktemp -d)
owner_pid=""
cleanup() {
  if [ -n "$owner_pid" ]; then
    kill "$owner_pid" 2>/dev/null || true
    wait "$owner_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

mkdir -p "${tmp_dir}/bin"
cat >"${tmp_dir}/bin/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

if [ "$MOCK_MODE" = acquire-error ]; then
  printf '%09000d\n' 0 >&2
  printf '::error::CF_ACCESS_CLIENT_SECRET=test-secret Authorization: Bearer test-bearer\n' >&2
  exit 255
fi

# Keep the actual remote holder and real flock; replace only the external SSH
# transport, remote privilege escalation and host-local filesystem location.
local_command=${2#sudo }
local_command=${local_command//"/var/lock/vm0-runner-lifecycle-${JOB_REF}.lock"/"${MOCK_ROOT}/holder.lock"}
case "$MOCK_MODE" in
  release-error)
    bash -c "$local_command"
    exit 255
    ;;
  missing-confirmation)
    bash -c "$local_command" 2>"${MOCK_ROOT}/remote.err"
    sed '/^VM0_RUNNER_LIFECYCLE_LOCK_RELEASED$/d' "${MOCK_ROOT}/remote.err" >&2
    ;;
  early-eof)
    # End the remote input only after the protected command has started. The
    # holder genuinely releases its flock and exits zero, but ownership is lost.
    mkfifo "${MOCK_ROOT}/input" "${MOCK_ROOT}/command-started"
    exec {input_fd}<>"${MOCK_ROOT}/input"
    exec {ready_fd}<>"${MOCK_ROOT}/command-started"
    bash -c "$local_command" <"${MOCK_ROOT}/input" {input_fd}>&- {ready_fd}>&- &
    remote_pid=$!
    IFS= read -r -t 10 ready <&"$ready_fd"
    [ "$ready" = ready ]
    exec {ready_fd}>&-
    exec {input_fd}>&-
    wait "$remote_pid"
    ;;
  normal) exec bash -c "$local_command" ;;
  *) exit 2 ;;
esac
SH

cat >"${tmp_dir}/bin/protected-command" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
trap 'printf "cancelled\n" >"${MOCK_ROOT}/command-cancelled"; exit 143' TERM
printf 'ready\n' >"${MOCK_ROOT}/command-ready"
printf 'ready\n' >"${MOCK_ROOT}/command-started"
sleep 30 &
wait "$!"
printf 'completed\n' >"${MOCK_ROOT}/command-completed"
SH
chmod +x "${tmp_dir}/bin/ssh" "${tmp_dir}/bin/protected-command"

export PATH="${tmp_dir}/bin:$PATH"
export JOB_REF=pr-42 METAL_HOSTS=metal.example.test METAL_USER=runner
export RUNNER_LIFECYCLE_LOCK_TIMEOUT_SECONDS=5 RUNNER_LIFECYCLE_LOCK_LEASE_SECONDS=5
export MOCK_ROOT MOCK_MODE

for scenario in acquire-error release-error missing-confirmation command-error early-eof; do
  MOCK_ROOT="${tmp_dir}/${scenario}"
  MOCK_MODE=$scenario
  mkdir -p "$MOCK_ROOT"
  command=(true)
  if [ "$scenario" = command-error ]; then
    MOCK_MODE=release-error
    command=(bash -c 'exit 37')
  elif [ "$scenario" = early-eof ]; then
    command=(protected-command)
  elif [ "$scenario" = acquire-error ]; then
    command=(touch "${MOCK_ROOT}/command-ready")
  fi
  status=0
  timeout 15 "$lock_script" "${command[@]}" >"${MOCK_ROOT}/out" 2>"${MOCK_ROOT}/err" || status=$?
  expected_status=1
  [ "$scenario" != command-error ] || expected_status=37
  [ "$status" -eq "$expected_status" ] || {
    sed 's/^/  /' "${MOCK_ROOT}/err" >&2
    fail "${scenario}: expected exit ${expected_status}, got ${status}"
  }
  case "$scenario" in
    acquire-error)
      grep -q 'namespace=pr-42 host=metal.example.test phase=acquire local_exit=255 remote_release=unconfirmed' \
        "${MOCK_ROOT}/err" || fail "acquisition did not preserve the SSH status"
      [ ! -e "${MOCK_ROOT}/command-ready" ] || fail "command ran without a lock"
      ! grep -Eq 'test-secret|test-bearer|::error::' "${MOCK_ROOT}/err" || fail "unsafe diagnostics"
      grep -Fq 'CF_ACCESS_CLIENT_SECRET=[redacted]' "${MOCK_ROOT}/err" || fail "missing sanitized evidence"
      [ "$(wc -c <"${MOCK_ROOT}/err")" -lt 8700 ] || fail "unbounded holder diagnostics"
      ;;
    release-error|command-error)
      grep -q 'phase=release local_exit=255 remote_release=confirmed' "${MOCK_ROOT}/err" ||
        fail "release confirmation hid the transport failure"
      ;;
    missing-confirmation)
      grep -q 'phase=release local_exit=0 remote_release=unconfirmed' "${MOCK_ROOT}/err" ||
        fail "missing remote confirmation was not reported"
      ;;
    early-eof)
      grep -q 'phase=running local_exit=0 remote_release=confirmed' "${MOCK_ROOT}/err" ||
        fail "early successful remote exit was not reported as ownership loss"
      [ -e "${MOCK_ROOT}/command-cancelled" ] || fail "ownership loss did not cancel the command"
      [ ! -e "${MOCK_ROOT}/command-completed" ] || fail "command completed after ownership loss"
      ;;
  esac
  flock --exclusive --nonblock "${MOCK_ROOT}/holder.lock" true || fail "${scenario}: lock leaked"
done

# Cancellation preserves the caller's signal exit while releasing real locks
# and stopping the protected command's process group.
MOCK_ROOT="${tmp_dir}/cancellation"
MOCK_MODE=normal
mkdir -p "$MOCK_ROOT"
mkfifo "${MOCK_ROOT}/command-started"
exec {command_ready_fd}<>"${MOCK_ROOT}/command-started"
"$lock_script" protected-command {command_ready_fd}>&- >"${MOCK_ROOT}/out" 2>"${MOCK_ROOT}/err" &
owner_pid=$!
IFS= read -r -t 10 ready <&"$command_ready_fd" || fail "protected command did not start"
[ "$ready" = ready ] || fail "invalid protected-command readiness marker"
exec {command_ready_fd}>&-
kill -TERM "$owner_pid"
status=0
wait "$owner_pid" || status=$?
owner_pid=""
[ "$status" -eq 143 ] || fail "cancellation did not preserve exit 143"
[ -e "${MOCK_ROOT}/command-cancelled" ] || fail "cancellation did not stop the command"
grep -q 'local_exit=0 remote_release=confirmed' "${MOCK_ROOT}/err" || fail "cancellation did not confirm release"
flock --exclusive --nonblock "${MOCK_ROOT}/holder.lock" true || fail "cancellation leaked the lock"

echo "runner-lifecycle-lock-diagnostics-test: ok"
