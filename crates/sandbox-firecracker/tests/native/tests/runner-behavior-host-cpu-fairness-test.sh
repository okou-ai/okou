#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
fairness_script=${1:-"${repo_root}/crates/sandbox-firecracker/tests/native/runner-behavior-host-cpu-fairness.sh"}
tmp_dir=$(mktemp -d)

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

[ -f "$fairness_script" ] || fail "fairness wrapper not found: $fairness_script"
command -v flock >/dev/null || fail "flock is required"

fake_bin="${tmp_dir}/bin"
test_bin="${tmp_dir}/host-cpu-fairness-test"
rootfs_hash=0000000000000000000000000000000000000000000000000000000000000000
online_cpus=$'# CPU,ONLINE\n0,Y\n1,Y\n2,Y'
mkdir -p "$fake_bin"

cat >"${fake_bin}/scp" <<'FAKE_SCP'
#!/usr/bin/env bash
set -euo pipefail

[ "$#" -eq 2 ] || {
  echo "unexpected scp invocation: $*" >&2
  exit 1
}
destination=${2#*:}
case "$destination" in
  /tmp/runner-host-cpu-fairness-*) ;;
  *)
    echo "unexpected remote binary path: $destination" >&2
    exit 1
    ;;
esac
mkdir -p "${MOCK_CASE_DIR}/upload"
cp -- "$1" "${MOCK_CASE_DIR}/upload/${destination##*/}"
FAKE_SCP

cat >"${fake_bin}/ssh" <<'FAKE_SSH'
#!/usr/bin/env bash
set -euo pipefail

# Execute the real remote scripts, mapping only host filesystem boundaries.
map_paths() {
  local value=$1
  value=${value//"/tmp/vm0-runner-behavior/host-cpu-fairness-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"/"${MOCK_CASE_DIR}/durable"}
  value=${value//"/tmp/runner-host-cpu-fairness-"/"${MOCK_CASE_DIR}/upload/runner-host-cpu-fairness-"}
  value=${value//"/run/lock/vm0-host-cpu-fairness"/"${MOCK_LOCK_ROOT}/pre-r5c"}
  value=${value//"/run/lock/runner-host-cpu-fairness"/"${MOCK_LOCK_ROOT}/interim"}
  value=${value//"/var/lib/vm0-runner/host-cpu-fairness"/"${MOCK_CASE_DIR}/base"}
  value=${value//"/var/lib/vm0-runner/firecracker"/"${MOCK_FIXTURE_ROOT}/firecracker"}
  value=${value//"/var/lib/vm0-runner/images"/"${MOCK_FIXTURE_ROOT}/images"}
  printf '%s' "$value"
}

shift
phase=cleanup
if [ "$#" -eq 1 ]; then
  case "$1" in
    *worker.XXXXXX*) phase=stage ;;
    "cat -- "*) phase=fetch ;;
  esac
elif [ "$#" -ge 10 ]; then
  phase=launch
elif [[ "${4:-}" == */status ]]; then
  phase=state
fi
count_file="${MOCK_CASE_DIR}/${phase}-count"
count=0
[ ! -f "$count_file" ] || count=$(<"$count_file")
count=$((count + 1))
printf '%s\n' "$count" >"$count_file"
if [ "${MOCK_SSH_FAILURES:-0}" = 1 ] && [ "$count" -eq 1 ] && [ "$phase" = state ]; then
  exit 255
fi

if [ "$#" -eq 1 ]; then
  command_source=$(map_paths "$1")
  if [ "$phase" = stage ]; then
    worker_source=$(cat)
    worker_source=$(map_paths "$worker_source")
    bash -c "$command_source" <<<"$worker_source"
  else
    bash -c "$command_source"
  fi
else
  [ "$1" = bash ] && [ "$2" = -s ] && [ "$3" = -- ]
  shift 3
  remote_arguments=()
  for argument in "$@"; do
    if [ "$argument" = /tmp ]; then
      remote_arguments+=("${MOCK_CASE_DIR}/upload")
    else
      remote_arguments+=("$(map_paths "$argument")")
    fi
  done
  remote_source=$(cat)
  bash -s -- "${remote_arguments[@]}" <<<"$remote_source"
fi

if [ "${MOCK_SSH_FAILURES:-0}" = 1 ] && [ "$count" -eq 1 ]; then
  case "$phase" in
    launch|fetch) exit 255 ;;
  esac
fi
FAKE_SSH

cat >"${fake_bin}/sudo" <<'FAKE_SUDO'
#!/usr/bin/env bash
set -euo pipefail
exec "$@"
FAKE_SUDO

cat >"${fake_bin}/lscpu" <<'FAKE_LSCPU'
#!/usr/bin/env bash
set -euo pipefail
[ "$*" = "--parse=CPU,ONLINE" ] || {
  echo "unexpected lscpu invocation: $*" >&2
  exit 1
}
printf '%s\n' "$MOCK_LSCPU_OUTPUT"
FAKE_LSCPU

cat >"${fake_bin}/systemd" <<'FAKE_SYSTEMD'
#!/usr/bin/env bash
set -euo pipefail
printf 'systemd 254 (254)\n'
FAKE_SYSTEMD

cat >"${fake_bin}/systemctl" <<'FAKE_SYSTEMCTL'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *--property=LoadState*)
    if [ -f "${MOCK_CASE_DIR}/active" ]; then
      echo loaded
    else
      echo not-found
    fi
    ;;
  *--property=ActiveState*) echo active ;;
  stop*) printf '%s\n' "$2" >>"${MOCK_CASE_DIR}/stopped-units" ;;
  *) exit 2 ;;
esac
FAKE_SYSTEMCTL

cat >"${fake_bin}/sleep" <<'FAKE_SLEEP'
#!/usr/bin/env bash
set -euo pipefail
/bin/sleep 0.01
FAKE_SLEEP

cat >"${fake_bin}/modprobe" <<'FAKE_MODPROBE'
#!/usr/bin/env bash
set -euo pipefail
exit 0
FAKE_MODPROBE

cat >"${fake_bin}/systemd-run" <<'FAKE_SYSTEMD_RUN'
#!/usr/bin/env bash
set -euo pipefail

selected_cpu=""
saw_wait=false
owner=""
after=""
runtime_bound=""
unit=""
environment=()
for argument in "$@"; do
  case "$argument" in
    --wait) saw_wait=true ;;
    --property=AllowedCPUs=*) selected_cpu=${argument##*=} ;;
    --property=BindsTo=*) owner=${argument##*=} ;;
    --property=After=*) after=${argument##*=} ;;
    --property=RuntimeMaxSec=*) runtime_bound=${argument##*=} ;;
    --unit=*) unit=${argument#*=} ;;
    --setenv=*) environment+=("${argument#*=}") ;;
  esac
done
if [ "$saw_wait" = false ]; then
  while [ "$#" -gt 0 ] && [ "$1" != /bin/bash ]; do
    shift
  done
  [ "$#" -gt 0 ]
  touch "${MOCK_CASE_DIR}/active"
  (
    exec 9>&-
    status=0
    env "${environment[@]}" "$@" || status=$?
    printf '%s\n' "$status" >"${MOCK_CASE_DIR}/unit-status"
    rm -f "${MOCK_CASE_DIR}/active"
  ) </dev/null >/dev/null 2>&1 &
  exit 0
fi
[ "$owner" = "$RUNNER_BEHAVIOR_DURABLE_UNIT" ] && [ "$after" = "$owner" ] || {
  echo "delegated test unit is not ordered under its durable owner" >&2
  exit 1
}
[ "$runtime_bound" = 180 ] || {
  echo "delegated test unit has no bounded runtime" >&2
  exit 1
}
[ -n "$selected_cpu" ] || {
  echo "systemd-run did not receive AllowedCPUs" >&2
  exit 1
}
case " $* " in
  *" --ignored --test-threads=1 --nocapture ") ;;
  *)
    echo "host CPU fairness test arguments changed" >&2
    exit 1
    ;;
esac
printf '%s\n' "$selected_cpu" >"${MOCK_CASE_DIR}/child-cpu"
printf '%s\n' "$unit" >>"${MOCK_CASE_DIR}/native-invocations"

if [ -n "${MOCK_CHILD_ENTER_FIFO:-}" ]; then
  printf 'entered\n' >"$MOCK_CHILD_ENTER_FIFO"
  IFS= read -r release <"$MOCK_CHILD_RELEASE_FIFO"
  [ "$release" = release ]
fi
echo "native fairness result: ${MOCK_NATIVE_STATUS:-0}"
exit "${MOCK_NATIVE_STATUS:-0}"
FAKE_SYSTEMD_RUN

printf '#!/usr/bin/env bash\nexit 0\n' >"$test_bin"
chmod +x "$test_bin" "${fake_bin}"/*

prepare_case() {
  local case_root=$1
  local fixture_root="${case_root}/fixtures"
  mkdir -p \
    "${case_root}/locks/pre-r5c" \
    "${case_root}/locks/interim" \
    "${fixture_root}/firecracker/v1" \
    "${fixture_root}/images/${rootfs_hash}"
  : >"${fixture_root}/firecracker/v1/firecracker"
  : >"${fixture_root}/firecracker/v1/vmlinux-test"
  : >"${fixture_root}/images/${rootfs_hash}/rootfs.ext4"
}

job_ref_for_start_index() {
  local prefix=$1
  local run_id=$2
  local desired_index=$3
  local candidate_count=$4
  local suffix checksum candidate execution_key

  for ((suffix = 0; suffix < 1000; suffix++)); do
    candidate="${prefix}-${suffix}"
    execution_key="${candidate}-${run_id}-1"
    checksum=$(printf '%s' "$execution_key" | cksum)
    checksum=${checksum%% *}
    if [ $((checksum % candidate_count)) -eq "$desired_index" ]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  fail "could not derive a deterministic selection key"
}

run_invocation() {
  local case_root=$1
  local invocation_name=$2
  local job_ref=$3
  local run_id=$4
  local invocation_dir="${case_root}/${invocation_name}"

  mkdir -p "$invocation_dir"
  env \
    PATH="${fake_bin}:$PATH" \
    MOCK_CASE_DIR="$invocation_dir" \
    MOCK_LOCK_ROOT="${case_root}/locks" \
    MOCK_FIXTURE_ROOT="${case_root}/fixtures" \
    MOCK_LSCPU_OUTPUT="$online_cpus" \
    MOCK_CHILD_ENTER_FIFO="${MOCK_CHILD_ENTER_FIFO:-}" \
    MOCK_CHILD_RELEASE_FIFO="${MOCK_CHILD_RELEASE_FIFO:-}" \
    MOCK_SSH_FAILURES="${MOCK_SSH_FAILURES:-0}" \
    MOCK_NATIVE_STATUS="${MOCK_NATIVE_STATUS:-0}" \
    METAL_USER=test-user \
    HOST=test-host \
    JOB_REF="$job_ref" \
    DEFAULT_ROOTFS_HASH="$rootfs_hash" \
    TEST_BIN="$test_bin" \
    GITHUB_RUN_ID="$run_id" \
    GITHUB_RUN_ATTEMPT=1 \
    timeout 15 bash "$fairness_script"
}

assert_selected_cpu() {
  local invocation_dir=$1
  local expected_cpu=$2
  local reason=$3

  [ "$(cat "${invocation_dir}/child-cpu")" = "$expected_cpu" ] ||
    fail "$reason"
}

assert_existing_lock_available() {
  local lock_file=$1
  local reason=$2
  local probe_fd

  [ -e "$lock_file" ] || fail "lock file was unlinked: $lock_file"
  exec {probe_fd}>"$lock_file"
  if ! flock --nonblock "$probe_fd"; then
    exec {probe_fd}>&-
    fail "$reason"
  fi
  flock --unlock "$probe_fd"
  exec {probe_fd}>&-
}

assert_lock_held() {
  local lock_file=$1
  local reason=$2
  local probe_fd

  [ -e "$lock_file" ] || fail "expected held lock file: $lock_file"
  exec {probe_fd}>"$lock_file"
  if flock --nonblock "$probe_fd"; then
    flock --unlock "$probe_fd"
    exec {probe_fd}>&-
    fail "$reason"
  fi
  exec {probe_fd}>&-
}

test_pre_r5c_holder() (
  local case_root="${tmp_dir}/pre-r5c-holder"
  local output="${case_root}/invocation.out"
  local errors="${case_root}/invocation.err"
  local job_ref holder_fd
  prepare_case "$case_root"

  exec {holder_fd}>"${case_root}/locks/pre-r5c/cpu-1.lock"
  flock --nonblock "$holder_fd" || fail "could not acquire pre-R5c fixture lock"
  job_ref=$(job_ref_for_start_index pre-r5c 101 0 2)

  run_invocation "$case_root" invocation "$job_ref" 101 >"$output" 2>"$errors" || {
    sed 's/^/  /' "$errors" >&2
    fail "repaired invocation failed with a pre-R5c holder"
  }
  # The #31906 single-interim-namespace implementation selects CPU 1 here.
  assert_selected_cpu "${case_root}/invocation" 2 \
    "pre-R5c holder did not rotate selection to the free candidate"
  assert_existing_lock_available \
    "${case_root}/locks/pre-r5c/cpu-2.lock" \
    "pre-R5c CPU 2 lock remained held after exit"
  assert_existing_lock_available \
    "${case_root}/locks/interim/cpu-2.lock" \
    "interim CPU 2 lock remained held after exit"
)

test_interim_holder_and_partial_release() (
  local case_root="${tmp_dir}/interim-holder"
  local output="${case_root}/invocation.out"
  local errors="${case_root}/invocation.err"
  local entered_fifo="${case_root}/child-entered"
  local release_fifo="${case_root}/child-release"
  local job_ref invocation_pid="" holder_fd entry_fd release_fd marker
  local pre_inode interim_inode

  cleanup_case() {
    if [ -n "$invocation_pid" ]; then
      kill "$invocation_pid" 2>/dev/null || true
      wait "$invocation_pid" 2>/dev/null || true
    fi
  }
  trap cleanup_case EXIT

  prepare_case "$case_root"
  mkfifo "$entered_fifo" "$release_fifo"
  exec {entry_fd}<>"$entered_fifo"
  exec {release_fd}<>"$release_fifo"
  exec {holder_fd}>"${case_root}/locks/interim/cpu-1.lock"
  flock --nonblock "$holder_fd" || fail "could not acquire interim fixture lock"
  job_ref=$(job_ref_for_start_index interim 102 0 2)

  MOCK_CHILD_ENTER_FIFO="$entered_fifo" \
    MOCK_CHILD_RELEASE_FIFO="$release_fifo" \
    run_invocation "$case_root" invocation "$job_ref" 102 \
    >"$output" 2>"$errors" &
  invocation_pid=$!
  IFS= read -r -t 5 marker <&"$entry_fd" || {
    sed 's/^/  /' "$errors" >&2
    fail "child did not start for interim contention case"
  }
  [ "$marker" = entered ] || fail "invalid child entry marker"

  assert_selected_cpu "${case_root}/invocation" 2 \
    "interim holder did not rotate selection to the free candidate"
  [ -e "${case_root}/locks/pre-r5c/cpu-1.lock" ] ||
    fail "legacy-first partial acquisition was not attempted"
  assert_existing_lock_available \
    "${case_root}/locks/pre-r5c/cpu-1.lock" \
    "partial pre-R5c acquisition was not released before rotation"
  assert_lock_held "${case_root}/locks/pre-r5c/cpu-2.lock" \
    "pre-R5c selected lock was not held through child execution"
  assert_lock_held "${case_root}/locks/interim/cpu-2.lock" \
    "interim selected lock was not held through child execution"

  pre_inode=$(stat -c '%i' "${case_root}/locks/pre-r5c/cpu-2.lock")
  interim_inode=$(stat -c '%i' "${case_root}/locks/interim/cpu-2.lock")
  printf 'release\n' >&"$release_fd"
  wait "$invocation_pid" || {
    sed 's/^/  /' "$errors" >&2
    fail "interim contention invocation failed after child release"
  }
  invocation_pid=""

  [ "$(stat -c '%i' "${case_root}/locks/pre-r5c/cpu-2.lock")" = "$pre_inode" ] ||
    fail "pre-R5c lock inode changed during exit"
  [ "$(stat -c '%i' "${case_root}/locks/interim/cpu-2.lock")" = "$interim_inode" ] ||
    fail "interim lock inode changed during exit"
  assert_existing_lock_available \
    "${case_root}/locks/pre-r5c/cpu-2.lock" \
    "pre-R5c selected lock remained held after child exit"
  assert_existing_lock_available \
    "${case_root}/locks/interim/cpu-2.lock" \
    "interim selected lock remained held after child exit"
  cleanup_case
  trap - EXIT
)

test_repaired_holder() (
  local case_root="${tmp_dir}/repaired-holder"
  local holder_output="${case_root}/holder.out"
  local holder_errors="${case_root}/holder.err"
  local contender_output="${case_root}/contender.out"
  local contender_errors="${case_root}/contender.err"
  local entered_fifo="${case_root}/child-entered"
  local release_fifo="${case_root}/child-release"
  local holder_job_ref contender_job_ref holder_pid="" entry_fd release_fd marker

  cleanup_case() {
    if [ -n "$holder_pid" ]; then
      kill "$holder_pid" 2>/dev/null || true
      wait "$holder_pid" 2>/dev/null || true
    fi
  }
  trap cleanup_case EXIT

  prepare_case "$case_root"
  mkfifo "$entered_fifo" "$release_fifo"
  exec {entry_fd}<>"$entered_fifo"
  exec {release_fd}<>"$release_fifo"
  holder_job_ref=$(job_ref_for_start_index repaired-holder 103 0 2)
  contender_job_ref=$(job_ref_for_start_index repaired-contender 104 0 2)

  MOCK_CHILD_ENTER_FIFO="$entered_fifo" \
    MOCK_CHILD_RELEASE_FIFO="$release_fifo" \
    run_invocation "$case_root" holder "$holder_job_ref" 103 \
    >"$holder_output" 2>"$holder_errors" &
  holder_pid=$!
  IFS= read -r -t 5 marker <&"$entry_fd" || {
    sed 's/^/  /' "$holder_errors" >&2
    fail "repaired holder child did not start"
  }
  [ "$marker" = entered ] || fail "invalid repaired holder entry marker"
  assert_selected_cpu "${case_root}/holder" 1 \
    "first repaired invocation did not select the first candidate"
  assert_lock_held "${case_root}/locks/pre-r5c/cpu-1.lock" \
    "repaired holder did not retain the pre-R5c lock"
  assert_lock_held "${case_root}/locks/interim/cpu-1.lock" \
    "repaired holder did not retain the interim lock"

  run_invocation "$case_root" contender "$contender_job_ref" 104 \
    >"$contender_output" 2>"$contender_errors" || {
    sed 's/^/  /' "$contender_errors" >&2
    fail "contender failed while another repaired invocation held CPU 1"
  }
  assert_selected_cpu "${case_root}/contender" 2 \
    "another repaired holder did not force rotation"

  printf 'release\n' >&"$release_fd"
  wait "$holder_pid" || {
    sed 's/^/  /' "$holder_errors" >&2
    fail "repaired holder failed after child release"
  }
  holder_pid=""
  assert_existing_lock_available \
    "${case_root}/locks/pre-r5c/cpu-1.lock" \
    "repaired holder retained the pre-R5c lock after exit"
  assert_existing_lock_available \
    "${case_root}/locks/interim/cpu-1.lock" \
    "repaired holder retained the interim lock after exit"
  cleanup_case
  trap - EXIT
)

test_all_busy_failure() (
  local case_root="${tmp_dir}/all-busy"
  local output="${case_root}/invocation.out"
  local errors="${case_root}/invocation.err"
  local job_ref legacy_fd interim_fd
  prepare_case "$case_root"

  exec {legacy_fd}>"${case_root}/locks/pre-r5c/cpu-1.lock"
  exec {interim_fd}>"${case_root}/locks/interim/cpu-2.lock"
  flock --nonblock "$legacy_fd" || fail "could not acquire CPU 1 fixture lock"
  flock --nonblock "$interim_fd" || fail "could not acquire CPU 2 fixture lock"
  job_ref=$(job_ref_for_start_index all-busy 105 0 2)

  if run_invocation "$case_root" invocation "$job_ref" 105 \
    >"$output" 2>"$errors"; then
    fail "all-busy invocation unexpectedly succeeded"
  fi
  grep -Fq "no online host CPU is available for the fairness test" "$output" || {
    sed 's/^/  /' "$errors" >&2
    fail "all-busy failure was not visible"
  }
  if grep -q '^HOST_CPU_SELECTED_CPU=' "$output"; then
    fail "all-busy invocation reported a selected CPU"
  fi
  assert_existing_lock_available \
    "${case_root}/locks/pre-r5c/cpu-2.lock" \
    "all-busy partial acquisition was not released"
)

test_durable_recovery() (
  local native_status=$1
  local case_root="${tmp_dir}/recovery-${native_status}"
  local invocation_dir="${case_root}/invocation"
  local output="${case_root}/invocation.out"
  local errors="${case_root}/invocation.err"
  local status=0
  prepare_case "$case_root"

  MOCK_SSH_FAILURES=1 MOCK_NATIVE_STATUS="$native_status" \
    run_invocation "$case_root" invocation recovery 106 \
    >"$output" 2>"$errors" || status=$?
  [ "$status" -eq "$native_status" ] || {
    sed 's/^/  /' "$output" "$errors" >&2
    fail "lost SSH responses changed native result ${native_status} to ${status}"
  }
  [ "$(wc -l <"${invocation_dir}/native-invocations")" -eq 1 ] ||
    fail "lost launch response replayed the native test"
  [ "$(cat "${invocation_dir}/launch-count")" -eq 2 ] ||
    fail "lost launch response was not recovered"
  [ "$(cat "${invocation_dir}/state-count")" -ge 2 ] ||
    fail "lost state response was not recovered"
  [ "$(cat "${invocation_dir}/fetch-count")" -eq 2 ] ||
    fail "lost log response was not recovered"
  [ "$(grep -Fc "native fairness result: ${native_status}" "$output")" -eq 1 ] ||
    fail "recovered log was missing or duplicated"
  grep -q '^HOST_CPU_SELECTED_CPU=' "$output" || fail "CPU selection log was lost"
  [ ! -e "${invocation_dir}/upload/runner-host-cpu-fairness-recovery-106-1" ] ||
    fail "uploaded binary was not cleaned"
  [ ! -e "${invocation_dir}/durable" ] || fail "durable result was not cleaned"
  [ ! -d "${invocation_dir}/base/recovery-106-1" ] || fail "test state was not cleaned"
  grep -Fxq "runner-host-cpu-managed-recovery-106-1.service" \
    "${invocation_dir}/stopped-units" || fail "delegated unit was not stopped"
  local selected_cpu
  selected_cpu=$(cat "${invocation_dir}/child-cpu")
  assert_existing_lock_available "${case_root}/locks/pre-r5c/cpu-${selected_cpu}.lock" \
    "recovered test retained pre-R5c CPU lock"
  assert_existing_lock_available "${case_root}/locks/interim/cpu-${selected_cpu}.lock" \
    "recovered test retained interim CPU lock"
)

test_pre_r5c_holder
test_interim_holder_and_partial_release
test_repaired_holder
test_all_busy_failure
test_durable_recovery 0
test_durable_recovery 37

echo "runner-behavior-host-cpu-fairness-test: ok"
