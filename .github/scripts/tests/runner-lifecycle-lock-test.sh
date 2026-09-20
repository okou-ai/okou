#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
barrier_script="${repo_root}/.github/scripts/cancel-superseded-merge-group-runs.sh"
lock_script="${repo_root}/.github/scripts/with-runner-lifecycle-lock.sh"
namespace_cleanup_script="${repo_root}/.github/scripts/cleanup-pr-runner-namespace.sh"
tmp_dir=$(mktemp -d)
background_pids=()

cleanup() {
  local pid
  for pid in "${background_pids[@]}"; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

fake_bin="${tmp_dir}/bin"
lock_root="${tmp_dir}/locks"
mkdir -p "$fake_bin" "$lock_root"

cat >"${fake_bin}/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

endpoint=""
for argument in "$@"; do
  case "$argument" in
    repos/*) endpoint=$argument ;;
  esac
done

case "$endpoint" in
  repos/okou-ai/okou/pulls/42)
    if [[ " $* " == *" --jq .state "* ]]; then
      case "${MOCK_PR_STATE:-closed}" in
        error) exit 1 ;;
        *) printf '%s\n' "${MOCK_PR_STATE:-closed}" ;;
      esac
    else
      printf 'feature/late-approval\tokou-ai/okou\n'
    fi
    ;;
  repos/okou-ai/okou/actions/runs)
    printf '[{"workflow_runs":[]}]\n'
    ;;
  *)
    echo "unexpected gh endpoint: ${endpoint}" >&2
    exit 1
    ;;
esac
SH

cat >"${fake_bin}/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

remote=$1
remote_command=$2
host=${remote#*@}
if [ -n "${MOCK_SSH_ATTEMPT_FIFO:-}" ]; then
  printf '%s\n' "${MOCK_OWNER:-unknown}" >"$MOCK_SSH_ATTEMPT_FIFO"
fi
mkdir -p "$MOCK_LOCK_ROOT"
lock_file="${MOCK_LOCK_ROOT}/${host}-${JOB_REF}.lock"

# Run the holder the script actually asks for, minus the privilege escalation
# and the absolute lock path that only exist on a metal host.
local_command=${remote_command#sudo }
local_command=${local_command//"/var/lock/vm0-runner-lifecycle-${JOB_REF}.lock"/$lock_file}
if [ -n "${MOCK_HOLDER_COMMAND_FILE:-}" ]; then
  printf '%s\n' "$local_command" >"$MOCK_HOLDER_COMMAND_FILE"
fi
exec bash -c "$local_command"
SH

cat >"${fake_bin}/ansible-playbook" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ -n "${MOCK_ANSIBLE_LOG:-}" ]; then
  printf 'ansible\n' >>"$MOCK_ANSIBLE_LOG"
  exit 0
fi
printf 'cleanup-entered\n' >"$MOCK_CLEANUP_READY_FIFO"
IFS= read -r release <"$MOCK_CLEANUP_RELEASE_FIFO"
[ "$release" = "release" ]
printf 'delete\n' >>"$MOCK_ORDER_LOG"
SH

cat >"${fake_bin}/late-start-critical" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'start\n' >>"$MOCK_ORDER_LOG"
SH
chmod +x "${fake_bin}/gh" "${fake_bin}/ssh" \
  "${fake_bin}/ansible-playbook" "${fake_bin}/late-start-critical"

barrier_output=$(
  env -i \
    PATH="${fake_bin}:$PATH" \
    HOME="${HOME:-/tmp}" \
    GH_TOKEN=test-token \
    GITHUB_REPOSITORY=okou-ai/okou \
    GITHUB_RUN_ID=900 \
    PR_NUMBER=42 \
    RUNNER_OWNER_SCOPE=closed-pr-cleanup \
    SUPERSEDED_RUN_POLL_SECONDS=0 \
    SUPERSEDED_RUN_TIMEOUT_SECONDS=5 \
    bash "$barrier_script"
)
grep -q "No active runner-owner CI runs found for PR #42" <<<"$barrier_output" ||
  fail "expected the stabilized discovery barrier to return an empty owner set"

# The protected cleanup helper must fail before Ansible when current GitHub
# state no longer authorizes deletion or cannot be resolved.
authority_ansible_log="${tmp_dir}/authority-ansible.log"
for rejected_state in open error; do
  if PATH="${fake_bin}:$PATH" \
    JOB_REF=pr-42 \
    GH_TOKEN=test-token \
    GITHUB_REPOSITORY=okou-ai/okou \
    GITHUB_RUN_ID=900 \
    METAL_HOSTS=metal-a.example.test \
    METAL_USER=runner \
    PR_NUMBER=42 \
    MOCK_ANSIBLE_LOG="$authority_ansible_log" \
    MOCK_PR_STATE="$rejected_state" \
    "$namespace_cleanup_script" >/dev/null 2>"${tmp_dir}/authority-${rejected_state}.err"; then
    fail "cleanup accepted rejected PR state ${rejected_state}"
  fi
done
[ ! -e "$authority_ansible_log" ] ||
  fail "cleanup reached Ansible without closed-PR authority"

cleanup_ready_fifo="${tmp_dir}/cleanup-ready"
cleanup_release_fifo="${tmp_dir}/cleanup-release"
late_attempt_fifo="${tmp_dir}/late-attempt"
order_log="${tmp_dir}/order.log"
mkfifo "$cleanup_ready_fifo" "$cleanup_release_fifo" "$late_attempt_fifo"
: >"$order_log"

PATH="${fake_bin}:$PATH" \
  JOB_REF=pr-42 \
  GH_TOKEN=test-token \
  GITHUB_REPOSITORY=okou-ai/okou \
  GITHUB_RUN_ID=900 \
  METAL_HOSTS=metal-a.example.test \
  METAL_USER=runner \
  PR_NUMBER=42 \
  MOCK_CLEANUP_READY_FIFO="$cleanup_ready_fifo" \
  MOCK_CLEANUP_RELEASE_FIFO="$cleanup_release_fifo" \
  MOCK_LOCK_ROOT="$lock_root" \
  MOCK_ORDER_LOG="$order_log" \
  RUNNER_LIFECYCLE_LOCK_TIMEOUT_SECONDS=5 \
  "$lock_script" "$namespace_cleanup_script" \
  >"${tmp_dir}/cleanup.out" 2>"${tmp_dir}/cleanup.err" &
cleanup_pid=$!
background_pids+=("$cleanup_pid")

cleanup_ready=$(
  # shellcheck disable=SC2016
  timeout 5 bash -c 'IFS= read -r line <"$1"; printf "%s\n" "$line"' \
    bash "$cleanup_ready_fifo"
) || {
  sed 's/^/  /' "${tmp_dir}/cleanup.err" >&2
  fail "cleanup did not enter its locked critical section"
}
[ "$cleanup_ready" = "cleanup-entered" ] ||
  fail "cleanup readiness marker was invalid"

# Model approval after the empty discovery snapshot: the late Turbo start now
# tries to acquire the same namespace while cleanup still owns deletion.
PATH="${fake_bin}:$PATH" \
  JOB_REF=pr-42 \
  METAL_HOSTS=metal-a.example.test \
  METAL_USER=runner \
  MOCK_LOCK_ROOT="$lock_root" \
  MOCK_ORDER_LOG="$order_log" \
  MOCK_OWNER=late-start \
  MOCK_SSH_ATTEMPT_FIFO="$late_attempt_fifo" \
  RUNNER_LIFECYCLE_LOCK_TIMEOUT_SECONDS=5 \
  "$lock_script" "$fake_bin/late-start-critical" \
  >"${tmp_dir}/late.out" 2>"${tmp_dir}/late.err" &
late_pid=$!
background_pids+=("$late_pid")

late_attempt=$(
  # shellcheck disable=SC2016
  timeout 5 bash -c 'IFS= read -r line <"$1"; printf "%s\n" "$line"' \
    bash "$late_attempt_fifo"
) || fail "late-approved start did not attempt to acquire the lifecycle lock"
[ "$late_attempt" = "late-start" ] || fail "late start attempt marker was invalid"
kill -0 "$late_pid" 2>/dev/null || fail "late start exited instead of waiting for cleanup"
[ ! -s "$order_log" ] || fail "late start entered while cleanup still held the namespace lock"

printf 'release\n' >"$cleanup_release_fifo"
wait "$cleanup_pid" || {
  sed 's/^/  /' "${tmp_dir}/cleanup.err" >&2
  fail "locked cleanup failed"
}
wait "$late_pid" || {
  sed 's/^/  /' "${tmp_dir}/late.err" >&2
  fail "late start failed after cleanup released the namespace"
}
background_pids=()

[ "$(cat "$order_log")" = $'delete\nstart' ] ||
  fail "cleanup and late start did not serialize in ownership order"

# A protected command that outlives the lease must keep its lock: the owner
# heartbeats over the same channel that carries the release signal.
lease_seconds=5
holder_command_file="${tmp_dir}/holder-command"
lease_lock_root="${tmp_dir}/lease-locks"
mkdir -p "$lease_lock_root"

PATH="${fake_bin}:$PATH" \
  JOB_REF=pr-77 \
  METAL_HOSTS=metal-lease.example.test \
  METAL_USER=runner \
  MOCK_LOCK_ROOT="$lease_lock_root" \
  MOCK_HOLDER_COMMAND_FILE="$holder_command_file" \
  RUNNER_LIFECYCLE_LOCK_TIMEOUT_SECONDS=5 \
  RUNNER_LIFECYCLE_LOCK_LEASE_SECONDS="$lease_seconds" \
  timeout "$((lease_seconds * 4))" "$lock_script" sleep "$((lease_seconds * 2))" \
  >"${tmp_dir}/lease.out" 2>"${tmp_dir}/lease.err" || {
  sed 's/^/  /' "${tmp_dir}/lease.err" >&2
  fail "heartbeats did not keep the lock while the protected command ran"
}
! grep -q "was lost while the protected command was running" "${tmp_dir}/lease.err" ||
  fail "the lease expired under an owner that was still heartbeating"

lease_lock_file="${lease_lock_root}/metal-lease.example.test-pr-77.lock"
flock --exclusive --timeout 5 "$lease_lock_file" true ||
  fail "the lock was still held after the protected command completed"

# Every host keeps its own heartbeat writer, so releasing must still reach
# end-of-input on each channel once the protected command finishes.
multi_lock_root="${tmp_dir}/multi-locks"
mkdir -p "$multi_lock_root"
PATH="${fake_bin}:$PATH" \
  JOB_REF=pr-78 \
  METAL_HOSTS=metal-one.example.test,metal-two.example.test \
  METAL_USER=runner \
  MOCK_LOCK_ROOT="$multi_lock_root" \
  RUNNER_LIFECYCLE_LOCK_TIMEOUT_SECONDS=5 \
  RUNNER_LIFECYCLE_LOCK_LEASE_SECONDS="$lease_seconds" \
  timeout "$lease_seconds" "$lock_script" true \
  >"${tmp_dir}/multi.out" 2>"${tmp_dir}/multi.err" || {
  sed 's/^/  /' "${tmp_dir}/multi.err" >&2
  fail "a multi-host lock did not release promptly after its protected command"
}
for multi_host in metal-one.example.test metal-two.example.test; do
  grep -q "namespace=pr-78 host=${multi_host} phase=release local_exit=0 remote_release=confirmed" \
    "${tmp_dir}/multi.err" || fail "missing successful release confirmation for ${multi_host}"
  flock --exclusive --timeout 5 \
    "${multi_lock_root}/${multi_host}-pr-78.lock" true ||
    fail "the lock on ${multi_host} was still held after release"
done

# An orphaned holder never sees end-of-input on a half-open transport, so the
# lease is the only thing that stops it from blocking the host indefinitely.
[ -s "$holder_command_file" ] || fail "the mock did not record the remote holder command"
holder_command=$(cat "$holder_command_file")
orphan_fifo="${tmp_dir}/orphan-stdin"
mkfifo "$orphan_fifo"
exec {orphan_fd}<>"$orphan_fifo"
bash -c "$holder_command" <"$orphan_fifo" >"${tmp_dir}/orphan.out" 2>&1 &
orphan_pid=$!
background_pids+=("$orphan_pid")

orphan_marker=$(
  # shellcheck disable=SC2016
  timeout 5 bash -c '
    until [ -s "$1" ]; do sleep 0.1; done
    IFS= read -r line <"$1"
    printf "%s\n" "$line"
  ' bash "${tmp_dir}/orphan.out"
) || fail "the orphaned holder never acquired the lock"
[ "$orphan_marker" = "VM0_RUNNER_LIFECYCLE_LOCK_ACQUIRED" ] ||
  fail "the orphaned holder reported an invalid acquisition marker"
flock --exclusive --timeout 1 "$lease_lock_file" true &&
  fail "the orphaned holder did not actually hold the lock"

flock --exclusive --timeout "$((lease_seconds * 3))" "$lease_lock_file" true ||
  fail "the orphaned holder kept the lock past its lease"
orphan_status=0
wait "$orphan_pid" || orphan_status=$?
[ "$orphan_status" -gt 128 ] || fail "the orphaned holder did not report its read timeout"
grep -Fxq VM0_RUNNER_LIFECYCLE_LOCK_LEASE_EXPIRED "${tmp_dir}/orphan.out" ||
  fail "the orphaned holder did not distinguish lease expiration from EOF"
! grep -Fxq VM0_RUNNER_LIFECYCLE_LOCK_RELEASED "${tmp_dir}/orphan.out" ||
  fail "the orphaned holder reported a normal release"
background_pids=()
exec {orphan_fd}>&-

echo "runner-lifecycle-lock-test: ok"
