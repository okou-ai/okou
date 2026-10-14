#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${SCRIPT_DIR}/run-nbd-cow-tests.sh"
TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

mkdir -p "${TEST_ROOT}/bin"
TEST_BIN="${TEST_ROOT}/test binary"
cat > "$TEST_BIN" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
[ "$*" = '--ignored --test-threads=1' ] || exit 2
printf 'test\n' >> "${FAKE_CASE}/tests.log"
exit "$FAKE_TEST_STATUS"
SCRIPT

cat > "${TEST_ROOT}/bin/scp" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
[ "$#" -eq 2 ] || exit 2
[ "$OKOU_CLOUDFLARE_SSH_OPERATION_TIMEOUT_SECONDS" = 60 ] || exit 2
[ "${2%%:*}" = 'metal@dev-test.vm3.ai' ] || exit 2
printf '%s\n' "$2" >> "${FAKE_CASE}/uploads.log"
attempt=$(wc -l < "${FAKE_CASE}/uploads.log")
IFS=',' read -r -a statuses <<< "$FAKE_UPLOAD_STATUSES"
status=${statuses[$((attempt - 1))]:?unexpected upload attempt}
candidate="${FAKE_CASE}/remote/${2##*/}"
# Deterministically model an old remote writer completing after its client
# failed. It must never overwrite the candidate a later attempt will execute.
for stale_candidate in "${FAKE_CASE}/remote/"*; do
  if [ -f "$stale_candidate" ]; then
    printf 'late stale bytes\n' > "$stale_candidate"
    printf '%s\n' "$stale_candidate" >> "${FAKE_CASE}/stale-writes.log"
  fi
done
if [ "$status" -eq 0 ]; then
  cp "$1" "$candidate"
else
  printf 'partial upload\n' > "$candidate"
  echo 'fixture transfer interrupted' >&2
fi
exit "$status"
SCRIPT

cat > "${TEST_ROOT}/bin/ssh" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
[ "$#" -eq 6 ] || exit 2
[ "$1" = 'metal@dev-test.vm3.ai' ] || exit 2
[ "$2 $3 $4" = 'bash -s --' ] || exit 2
printf 'ssh\n' >> "${FAKE_CASE}/ssh.log"
status=0
bash -s -- "${FAKE_CASE}/remote/${5##*/}" "${FAKE_CASE}/remote/${6##*/}" || status=$?
if [ "$status" -eq 0 ]; then
  # Model loss of the result channel after the remote test already ran.
  status=$FAKE_SSH_STATUS
fi
exit "$status"
SCRIPT

cat > "${TEST_ROOT}/bin/sudo" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = modprobe ]; then
  [ "$*" = 'modprobe nbd nbds_max=4096' ] || exit 2
  printf 'modprobe\n' >> "${FAKE_CASE}/modprobe.log"
  exit 0
fi
cmp "$TEST_BIN" "$1"
printf '%s\n' "${1##*/}" >> "${FAKE_CASE}/executed-candidates.log"
exec "$@"
SCRIPT
chmod +x "$TEST_BIN" "${TEST_ROOT}/bin/"*

case_count=0
run_case() {
  local statuses=$1 expected_attempts=$2 expected_status=$3 expected_tests=$4
  local test_status=${5:-0} ssh_status=${6:-0}
  local architecture=${7:-arm64} run_attempt=${8:-1}
  local case_dir status=0 expected_prefix attempt log
  case_count=$((case_count + 1))
  case_dir="${TEST_ROOT}/case-${case_count}"
  mkdir -p "${case_dir}/remote"
  for log in uploads ssh tests modprobe executed-candidates stale-writes; do
    : > "${case_dir}/${log}.log"
  done

  PATH="${TEST_ROOT}/bin:$PATH" \
    FAKE_CASE="$case_dir" \
    FAKE_UPLOAD_STATUSES="$statuses" \
    FAKE_TEST_STATUS="$test_status" \
    FAKE_SSH_STATUS="$ssh_status" \
    TEST_BIN="$TEST_BIN" \
    METAL_USER=metal HOST=dev-test.vm3.ai \
    GITHUB_RUN_ID=987654 GITHUB_RUN_ATTEMPT="$run_attempt" \
    RUNNER_HOST_GROUP_ID="$architecture" \
    bash "$SCRIPT" > "${case_dir}/out" 2>&1 || status=$?

  if [ "$status" -ne "$expected_status" ]; then
    cat "${case_dir}/out" >&2
    fail "${statuses}: expected status ${expected_status}, got ${status}"
  fi
  [ "$(wc -l < "${case_dir}/uploads.log")" -eq "$expected_attempts" ] \
    || fail "${statuses}: upload attempt limit was not respected"
  [ "$(wc -l < "${case_dir}/tests.log")" -eq "$expected_tests" ] \
    || fail "${statuses}: actual tests must never be replayed"
  [ "$(wc -l < "${case_dir}/ssh.log")" -eq "$expected_tests" ] \
    || fail "${statuses}: remote test command must be submitted at most once"
  [ "$(wc -l < "${case_dir}/modprobe.log")" -eq "$expected_tests" ] \
    || fail "${statuses}: module setup must not be replayed"

  expected_prefix="nbd-cow-test-987654-${run_attempt}-${architecture}"
  for ((attempt = 1; attempt <= expected_attempts; attempt++)); do
    grep -Fxq "metal@dev-test.vm3.ai:/tmp/${expected_prefix}-${attempt}" \
      "${case_dir}/uploads.log" || fail "candidate must be isolated by run and upload attempt"
  done
  if [ "$expected_tests" -eq 1 ]; then
    grep -Fxq "${expected_prefix}-${expected_attempts}" \
      "${case_dir}/executed-candidates.log" || fail "only the complete successful candidate may execute"
    [ -z "$(find "${case_dir}/remote" -type f)" ] \
      || fail "the remote test session must clean up all upload candidates"
    if [ "$expected_attempts" -gt 1 ]; then
      [ -s "${case_dir}/stale-writes.log" ] || fail "late remote writes must be exercised"
    fi
  else
    [ ! -s "${case_dir}/executed-candidates.log" ] \
      || fail "an unsuccessful upload must never execute a partial binary"
  fi
}

run_case 0 1 0 1
for transport_status in 124 141 255; do
  run_case "${transport_status},0" 2 0 1
  run_case "${transport_status},${transport_status},0" 3 0 1
  run_case "${transport_status},${transport_status},${transport_status}" 3 "$transport_status" 0
done
for terminal_status in 1 7 130 137 143; do
  run_case "$terminal_status" 1 "$terminal_status" 0
done
run_case 255,143 2 143 0
run_case 0 1 42 1 42
run_case 0 1 255 1 0 255
run_case 255,0 2 0 1 0 0 x86_64 2

echo "nbd-cow-upload-test: ${case_count} cases passed"
