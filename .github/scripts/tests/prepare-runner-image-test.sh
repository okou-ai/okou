#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREPARE="${SCRIPT_DIR}/prepare-runner-image.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=dev-1 \
  METAL_USER=ci \
  TARGET_TRIPLE='' \
  "$PREPARE" >"${TMPDIR}/empty.out" 2>"${TMPDIR}/empty.err"; then
  fail "expected empty target to fail"
fi
grep -q "missing runner image target" "${TMPDIR}/empty.err" || fail "expected missing target message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=dev-1 \
  METAL_USER=ci \
  TARGET_TRIPLE=powerpc-unknown-linux-musl \
  "$PREPARE" >"${TMPDIR}/unsupported.out" 2>"${TMPDIR}/unsupported.err"; then
  fail "expected unsupported target to fail"
fi
grep -q "unsupported runner image target: powerpc-unknown-linux-musl" "${TMPDIR}/unsupported.err" || fail "expected unsupported target message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=' ,  ' \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  "$PREPARE" >"${TMPDIR}/empty-hosts.out" 2>"${TMPDIR}/empty-hosts.err"; then
  fail "expected empty metal hosts to fail"
fi
grep -q "METAL_HOSTS is empty" "${TMPDIR}/empty-hosts.err" || fail "expected empty metal hosts message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS='bad/host' \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  "$PREPARE" >"${TMPDIR}/invalid-hosts.out" 2>"${TMPDIR}/invalid-hosts.err"; then
  fail "expected invalid metal hosts to fail"
fi
grep -q "invalid METAL_HOSTS entry: bad/host" "${TMPDIR}/invalid-hosts.err" || fail "expected invalid metal hosts message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS='user@host' \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  "$PREPARE" >"${TMPDIR}/invalid-user-host.out" 2>"${TMPDIR}/invalid-user-host.err"; then
  fail "expected user-qualified metal host to fail"
fi
grep -q "invalid METAL_HOSTS entry: user@host" "${TMPDIR}/invalid-user-host.err" || fail "expected user-qualified metal host message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS='host-' \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  "$PREPARE" >"${TMPDIR}/invalid-alias.out" 2>"${TMPDIR}/invalid-alias.err"; then
  fail "expected invalid metal host alias to fail"
fi
grep -qF "invalid METAL_HOSTS entry: host-" "${TMPDIR}/invalid-alias.err" || fail "expected invalid metal host alias message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS='dev-1, dev-1' \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  "$PREPARE" >"${TMPDIR}/duplicate-hosts.out" 2>"${TMPDIR}/duplicate-hosts.err"; then
  fail "expected duplicate metal hosts to fail"
fi
grep -q "duplicate METAL_HOSTS entry: dev-1" "${TMPDIR}/duplicate-hosts.err" || fail "expected duplicate metal hosts message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS='Dev-1, dev-1' \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  "$PREPARE" >"${TMPDIR}/duplicate-hosts-case.out" 2>"${TMPDIR}/duplicate-hosts-case.err"; then
  fail "expected case-insensitive duplicate metal hosts to fail"
fi
grep -q "duplicate METAL_HOSTS entry: dev-1" "${TMPDIR}/duplicate-hosts-case.err" || fail "expected case-insensitive duplicate metal hosts message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=dev-1 \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH='' \
  "$PREPARE" >"${TMPDIR}/arch-empty.out" 2>"${TMPDIR}/arch-empty.err"; then
  fail "expected empty expected remote arch to fail"
fi
grep -q "EXPECTED_REMOTE_ARCH is empty" "${TMPDIR}/arch-empty.err" || fail "expected empty expected remote arch message"

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=dev-1 \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=x86_64 \
  "$PREPARE" >"${TMPDIR}/arch-mismatch.out" 2>"${TMPDIR}/arch-mismatch.err"; then
  fail "expected expected remote arch mismatch to fail"
fi
grep -q "EXPECTED_REMOTE_ARCH mismatch: aarch64-unknown-linux-musl maps to aarch64, got x86_64" "${TMPDIR}/arch-mismatch.err" || fail "expected expected remote arch mismatch message"

if grep -q 'runner-binary-build/build.sh' "$PREPARE"; then
  fail "host preparation must not invoke the runner binary build"
fi

if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=dev-1 \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  "$PREPARE" >"${TMPDIR}/missing-runner.out" 2>"${TMPDIR}/missing-runner.err"; then
  fail "expected a missing supplied runner to fail"
fi
grep -q "missing required env: RUNNER_PATH" "${TMPDIR}/missing-runner.err" || fail "expected missing runner path message"

. "${SCRIPT_DIR}/runner-guest-binaries.sh"
. "${SCRIPT_DIR}/runner-binary-build/contract.env"
runner_guest_binaries_load
runner="${TMPDIR}/runner"
cat > "$runner" <<'BASH'
#!/usr/bin/env bash
[ "${1:-}" = --version ] || exit 2
echo runner-fixture
BASH
runner_sha=$(sha256sum "$runner" | awk '{print $1}')
runner_size=$(stat -c '%s' "$runner")
input_digest=$(printf 'a%.0s' {1..64})
guest_json='{}'
for guest in "${RUNNER_GUEST_BINARIES[@]}"; do
  guest_sha=$(printf '%s' "$guest" | sha256sum | awk '{print $1}')
  guest_json=$(jq -c --arg guest "$guest" --arg sha "$guest_sha" '. + {($guest): $sha}' <<<"$guest_json")
done
metadata="${TMPDIR}/metadata.json"
jq -n \
  --arg digest "$input_digest" \
  --arg toolchain "$RUNNER_BINARY_TOOLCHAIN_IMAGE" \
  --arg sha "$runner_sha" \
  --argjson size "$runner_size" \
  --argjson guests "$guest_json" '
    {
      schemaVersion: 1,
      binaryInputDigest: $digest,
      target: "aarch64-unknown-linux-musl",
      toolchainImage: $toolchain,
      runnerSha256: $sha,
      runnerSizeBytes: $size,
      guestSha256: $guests
    }
  ' > "$metadata"

printf 'wrong bytes\n' > "${TMPDIR}/wrong-runner"
if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=dev-1 \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  RUNNER_PATH="${TMPDIR}/wrong-runner" \
  FRESH_METADATA_PATH="$metadata" \
  EXPECTED_BINARY_INPUT_DIGEST="$input_digest" \
  "$PREPARE" >"${TMPDIR}/wrong-bytes.out" 2>"${TMPDIR}/wrong-bytes.err"; then
  fail "expected mismatched supplied runner bytes to fail"
fi
grep -q "fresh runner size mismatch" "${TMPDIR}/wrong-bytes.err" || fail "expected supplied runner validation message"

ln -s "$metadata" "${TMPDIR}/metadata-link.json"
if JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=dev-1 \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  RUNNER_PATH="$runner" \
  FRESH_METADATA_PATH="${TMPDIR}/metadata-link.json" \
  EXPECTED_BINARY_INPUT_DIGEST="$input_digest" \
  "$PREPARE" >"${TMPDIR}/metadata-link.out" 2>"${TMPDIR}/metadata-link.err"; then
  fail "expected symlinked supplied metadata to fail"
fi
grep -q "fresh runner metadata is not a regular file" "${TMPDIR}/metadata-link.err" || fail "expected metadata symlink validation message"

mkdir -p "${TMPDIR}/bin"
cat > "${TMPDIR}/bin/ssh" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

remote=$1
shift
{
  printf '%s' "$remote"
  printf ' %s' "$@"
  printf '\n'
} >> "$SSH_LOG"

if [ "$#" -eq 2 ] && [ "$1" = "uname" ] && [ "$2" = "-m" ]; then
  echo "aarch64"
  exit 0
fi

if [ "${1:-}" = "bash" ] && [ "${2:-}" = "-s" ]; then
  if [[ "${4:-}" = *.XXXXXX ]]; then
    # Map the remote filesystem into the fixture, retaining the real allocator.
    bash -s -- "${SSH_UPLOAD_DIR}/${4##*/}"
    exit 0
  fi
  if [[ "${4:-}" = *.tmp.* ]]; then
    if [ -n "${SSH_UPLOAD_STATUSES:-}" ]; then
      # Execute the production checksum/executable validation and publication.
      "$@"
    fi
    exit 0
  fi

  "$@"
  if [ "${SSH_REACH_GC:-}" != "1" ]; then
    # Service cleanup cases stop before emulating binary installation.
    exit 42
  fi
  exit 0
fi

if [ "${1:-}" = "sudo" ] && [ "${2:-}" = "install" ]; then
  if [ -n "${SSH_UPLOAD_STATUSES:-}" ]; then
    upload_attempt=$(( $(< "$SSH_UPLOAD_COUNT_FILE") + 1 ))
    printf '%s\n' "$upload_attempt" > "$SSH_UPLOAD_COUNT_FILE"
    IFS=',' read -r -a upload_statuses <<< "$SSH_UPLOAD_STATUSES"
    if [ "$upload_attempt" -gt "${#upload_statuses[@]}" ]; then
      echo "unexpected upload attempt ${upload_attempt}" >&2
      exit 1
    fi
    candidate=${*: -1}
    status=${upload_statuses[$((upload_attempt - 1))]}
    if [ "$status" -ne 0 ]; then
      head -c 4 > "$candidate"
      printf '%s\n' "$candidate" > "${SSH_UPLOAD_DIR}/failed-candidate"
      echo "fixture transfer interrupted" >&2
      exit "$status"
    fi

    install -m 755 /dev/stdin "$candidate"
    if [ "${SSH_UPLOAD_CORRUPT:-}" = 1 ]; then
      printf 'corrupt bytes\n' > "$candidate"
    fi
    if [ -f "${SSH_UPLOAD_DIR}/failed-candidate" ]; then
      # A previous remote writer resumes after the new transfer completes.
      printf 'late stale bytes\n' > "$(< "${SSH_UPLOAD_DIR}/failed-candidate")"
    fi
  fi
  exit 0
fi

if [ "${1:-}" = "sudo" ] && [ "${3:-}" = "gc" ]; then
  gc_attempt=$(( $(< "$SSH_GC_COUNT_FILE") + 1 ))
  printf '%s\n' "$gc_attempt" > "$SSH_GC_COUNT_FILE"
  IFS=',' read -r -a gc_statuses <<< "$SSH_GC_STATUSES"
  if [ "$gc_attempt" -gt "${#gc_statuses[@]}" ]; then
    echo "unexpected GC attempt ${gc_attempt}" >&2
    exit 1
  fi
  exit "${gc_statuses[$((gc_attempt - 1))]}"
fi

if [ "${1:-}" = "sudo" ] && [ "${3:-}" = "setup" ]; then
  exit 42
fi

exit 42
BASH
cat > "${TMPDIR}/bin/sudo" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

command=$1
shift
case "$command" in
  sha256sum|mktemp)
    exec "$command" "$@"
    ;;
  mv)
    [ "$1" = -f ] && [ "$3" = /var/lib/vm0-runner/bin/pr-123/runner ] || exit 1
    mv -f "$2" "${SSH_UPLOAD_DIR}/runner"
    ;;
  "${SSH_UPLOAD_DIR}/"*)
    exec "$command" "$@"
    ;;
  systemctl)
    exec systemctl "$@"
    ;;
  rm|mkdir|find)
    if [ "$command" = rm ] && [[ "${2:-}" = "${SSH_UPLOAD_DIR}/"* ]]; then
      exec rm "$@"
    fi
    {
      printf 'mutate %s' "$command"
      printf ' %s' "$@"
      printf '\n'
    } >> "$SYSTEMCTL_LOG"
    ;;
  *)
    echo "unexpected sudo command: ${command}" >&2
    exit 1
    ;;
esac
BASH
cat > "${TMPDIR}/bin/systemctl" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

command=$1
shift
case "$command" in
  list-units)
    echo "list-units" >> "$SYSTEMCTL_LOG"
    if [ -n "${SYSTEMCTL_LIST_FAILURE:-}" ]; then
      echo "mock list-units failure" >&2
      exit 1
    fi
    for state_path in "${SYSTEMCTL_STATE_DIR}"/*; do
      [ -f "$state_path" ] || continue
      unit=${state_path##*/}
      state=$(< "$state_path")
      load_state=$(< "${SYSTEMCTL_LOAD_STATE_DIR}/${unit}")
      printf '%s %s %s fixture fixture\n' "$unit" "$load_state" "$state"
    done
    cat "$SYSTEMCTL_EXTRA_LIST_ROWS_FILE"
    ;;
  stop)
    {
      printf 'stop'
      printf ' %s' "$@"
      printf '\n'
    } >> "$SYSTEMCTL_LOG"
    for unit in "$@"; do
      if [ "$unit" = "${SYSTEMCTL_STOP_FAILURE_UNIT:-}" ]; then
        echo "mock stop failure for ${unit}" >&2
        exit 1
      fi
    done
    for unit in "$@"; do
      if [ "$unit" != "${SYSTEMCTL_STICKY_UNIT:-}" ]; then
        printf 'inactive\n' > "${SYSTEMCTL_STATE_DIR}/${unit}"
      fi
    done
    ;;
  show)
    unit=${*: -1}
    echo "show ${unit}" >> "$SYSTEMCTL_LOG"
    if [ -f "${SYSTEMCTL_STATE_DIR}/${unit}" ]; then
      cat "${SYSTEMCTL_STATE_DIR}/${unit}"
    else
      echo "inactive"
    fi
    ;;
  reset-failed)
    {
      printf 'reset-failed'
      printf ' %s' "$@"
      printf '\n'
    } >> "$SYSTEMCTL_LOG"
    ;;
  *)
    echo "unexpected systemctl command: ${command}" >&2
    exit 1
    ;;
esac
BASH
chmod +x "${TMPDIR}/bin/ssh" "${TMPDIR}/bin/sudo" "${TMPDIR}/bin/systemctl"

prepare_remote_case() {
  local case_dir=$1
  mkdir -p "${case_dir}/state" "${case_dir}/load-state" "${case_dir}/uploads"
  : > "${case_dir}/ssh.log"
  : > "${case_dir}/systemctl.log"
  : > "${case_dir}/extra-list-rows"
  printf '0\n' > "${case_dir}/gc-count"
  printf '0\n' > "${case_dir}/upload-count"
}

set_unit_state() {
  local case_dir=$1
  local unit=$2
  local state=$3
  local load_state=${4:-loaded}
  printf '%s\n' "$state" > "${case_dir}/state/${unit}"
  printf '%s\n' "$load_state" > "${case_dir}/load-state/${unit}"
}

run_remote_case() {
  local case_dir=$1
  local list_failure=${2:-}
  local stop_failure_unit=${3:-}
  local sticky_unit=${4:-}
  if PATH="${TMPDIR}/bin:${PATH}" \
    SSH_LOG="${case_dir}/ssh.log" \
    SSH_GC_COUNT_FILE="${case_dir}/gc-count" \
    SSH_GC_STATUSES="${REMOTE_GC_STATUSES:-}" \
    SSH_REACH_GC="${REMOTE_REACH_GC:-}" \
    SSH_UPLOAD_DIR="${case_dir}/uploads" \
    SSH_UPLOAD_COUNT_FILE="${case_dir}/upload-count" \
    SSH_UPLOAD_STATUSES="${REMOTE_UPLOAD_STATUSES:-}" \
    SSH_UPLOAD_CORRUPT="${REMOTE_UPLOAD_CORRUPT:-}" \
    SYSTEMCTL_LOG="${case_dir}/systemctl.log" \
    SYSTEMCTL_STATE_DIR="${case_dir}/state" \
    SYSTEMCTL_LOAD_STATE_DIR="${case_dir}/load-state" \
    SYSTEMCTL_EXTRA_LIST_ROWS_FILE="${case_dir}/extra-list-rows" \
    SYSTEMCTL_LIST_FAILURE="$list_failure" \
    SYSTEMCTL_STOP_FAILURE_UNIT="$stop_failure_unit" \
    SYSTEMCTL_STICKY_UNIT="$sticky_unit" \
    JOB_REF=pr-123 \
    HEAD_SHA=abc \
    METAL_HOSTS=dev-arm-1 \
    METAL_USER=ci \
    TARGET_TRIPLE=aarch64-unknown-linux-musl \
    EXPECTED_REMOTE_ARCH=aarch64 \
    RUNNER_PATH="$runner" \
    FRESH_METADATA_PATH="$metadata" \
    EXPECTED_BINARY_INPUT_DIGEST="$input_digest" \
    MANIFEST_PATH="${case_dir}/manifest.json" \
    "$PREPARE" >"${case_dir}/out" 2>"${case_dir}/err"; then
    fail "expected mocked post-preparation SSH boundary to fail"
  fi
}

success_case="${TMPDIR}/remote-success"
prepare_remote_case "$success_case"
set_unit_state "$success_case" "vm0-runner-pr-123-2.service" active
set_unit_state "$success_case" "vm0-runner-pr-123-7.service" active
set_unit_state "$success_case" "vm0-runner-pr-123-exec.service" active
set_unit_state "$success_case" "vm0-runner-pr-123-keepalive.service" active
set_unit_state "$success_case" "vm0-runner-pr-123-cancel.service" active
set_unit_state "$success_case" "vm0-runner-pr-123-9.service" active not-found
set_unit_state "$success_case" "vm0-runner-pr-123-10.service" active masked
run_remote_case "$success_case"
grep -q 'ci@dev-arm-1 uname -m' "${success_case}/ssh.log" || fail "valid supplied runner must reach the SSH boundary"
grep -Eq '^stop .*vm0-runner-pr-123-2\.service([[:space:]]|$)' "${success_case}/systemctl.log" || fail "expected primary runner suffix 2 to stop"
grep -Eq '^stop .*vm0-runner-pr-123-7\.service([[:space:]]|$)' "${success_case}/systemctl.log" || fail "expected primary runner suffix 7 to stop"
if grep '^stop ' "${success_case}/systemctl.log" | grep -Eq 'vm0-runner-pr-123-(exec|keepalive|cancel)\.service'; then
  fail "auxiliary runner services must not stop"
fi
if grep '^stop ' "${success_case}/systemctl.log" | grep -q 'vm0-runner-pr-123-1\.service'; then
  fail "architecture-subset index must not determine the stopped service"
fi
if grep -Eq '^(stop|show|reset-failed).*vm0-runner-pr-123-(9|10)\.service' "${success_case}/systemctl.log"; then
  fail "non-loaded primary runner rows must not participate in cleanup"
fi
[ "$(< "${success_case}/state/vm0-runner-pr-123-2.service")" = "inactive" ] || fail "expected primary runner suffix 2 to be inactive"
[ "$(< "${success_case}/state/vm0-runner-pr-123-7.service")" = "inactive" ] || fail "expected primary runner suffix 7 to be inactive"
[ "$(< "${success_case}/state/vm0-runner-pr-123-exec.service")" = "active" ] || fail "expected auxiliary runner to remain active"
[ "$(< "${success_case}/state/vm0-runner-pr-123-9.service")" = "active" ] || fail "expected not-found runner row to remain untouched"
[ "$(< "${success_case}/state/vm0-runner-pr-123-10.service")" = "active" ] || fail "expected masked runner row to remain untouched"
last_show_line=$(grep -n '^show ' "${success_case}/systemctl.log" | tail -n1 | cut -d: -f1)
first_mutation_line=$(grep -n '^mutate ' "${success_case}/systemctl.log" | head -n1 | cut -d: -f1)
[ -n "$last_show_line" ] || fail "expected post-stop state verification"
[ -n "$first_mutation_line" ] || fail "expected shared-path mutation after verification"
[ "$last_show_line" -lt "$first_mutation_line" ] || fail "shared paths must not change before state verification"

no_primary_case="${TMPDIR}/remote-no-primary"
prepare_remote_case "$no_primary_case"
set_unit_state "$no_primary_case" "vm0-runner-pr-123-exec.service" active
run_remote_case "$no_primary_case"
if grep -q '^stop ' "${no_primary_case}/systemctl.log"; then
  fail "preparation without a primary runner must not stop auxiliary services"
fi
grep -q '^mutate rm ' "${no_primary_case}/systemctl.log" || fail "preparation without a primary runner must continue"

discovery_failure_case="${TMPDIR}/remote-discovery-failure"
prepare_remote_case "$discovery_failure_case"
set_unit_state "$discovery_failure_case" "vm0-runner-pr-123-2.service" active
run_remote_case "$discovery_failure_case" 1
if grep -q '^mutate ' "${discovery_failure_case}/systemctl.log"; then
  fail "discovery failure must prevent shared-path mutation"
fi
grep -q 'mock list-units failure' "${discovery_failure_case}/out" || fail "expected discovery failure output"

malformed_loaded_case="${TMPDIR}/remote-malformed-loaded"
prepare_remote_case "$malformed_loaded_case"
printf '%s\n' "vm0-runner-pr-123-2.service loaded active" >> "${malformed_loaded_case}/extra-list-rows"
run_remote_case "$malformed_loaded_case"
if grep -q '^mutate ' "${malformed_loaded_case}/systemctl.log"; then
  fail "malformed loaded row must prevent shared-path mutation"
fi
grep -q 'malformed loaded runner service row: vm0-runner-pr-123-2.service loaded active' "${malformed_loaded_case}/out" || fail "expected malformed loaded row output"

stop_failure_case="${TMPDIR}/remote-stop-failure"
prepare_remote_case "$stop_failure_case"
set_unit_state "$stop_failure_case" "vm0-runner-pr-123-2.service" active
run_remote_case "$stop_failure_case" '' "vm0-runner-pr-123-2.service"
if grep -q '^mutate ' "${stop_failure_case}/systemctl.log"; then
  fail "stop failure must prevent shared-path mutation"
fi
grep -q 'mock stop failure for vm0-runner-pr-123-2.service' "${stop_failure_case}/out" || fail "expected stop failure output"

verification_failure_case="${TMPDIR}/remote-verification-failure"
prepare_remote_case "$verification_failure_case"
set_unit_state "$verification_failure_case" "vm0-runner-pr-123-2.service" active
run_remote_case "$verification_failure_case" '' '' "vm0-runner-pr-123-2.service"
if grep -q '^mutate ' "${verification_failure_case}/systemctl.log"; then
  fail "verification failure must prevent shared-path mutation"
fi
grep -q 'runner service vm0-runner-pr-123-2.service is active after stop' "${verification_failure_case}/out" || fail "expected verification failure output"

gc_command='ci@dev-arm-1 sudo /var/lib/vm0-runner/bin/pr-123/runner gc --keep-latest 6'
setup_command='ci@dev-arm-1 sudo /var/lib/vm0-runner/bin/pr-123/runner setup'

gc_success_case="${TMPDIR}/gc-success"
prepare_remote_case "$gc_success_case"
REMOTE_REACH_GC=1 REMOTE_GC_STATUSES=0 run_remote_case "$gc_success_case"
[ "$(< "${gc_success_case}/gc-count")" -eq 1 ] || fail "successful GC must run once"
[ "$(grep -Fxc -- "$gc_command" "${gc_success_case}/ssh.log")" -eq 1 ] || fail "successful GC must invoke the runner directly once"
grep -Fqx -- "$setup_command" "${gc_success_case}/ssh.log" || fail "successful GC must continue to runner setup"

gc_retry_case="${TMPDIR}/gc-retry"
prepare_remote_case "$gc_retry_case"
REMOTE_REACH_GC=1 \
REMOTE_GC_STATUSES=255,0 \
  run_remote_case "$gc_retry_case"
gc_retry_count=$(< "${gc_retry_case}/gc-count")
[ "$gc_retry_count" -eq 2 ] || fail "SSH status 255 must retry GC once"
[ "$(grep -Fxc -- "$gc_command" "${gc_retry_case}/ssh.log")" -eq 2 ] || fail "each GC retry must invoke the runner directly"
grep -Fq 'runner GC SSH transport failed on dev-arm-1 with status 255; retrying once' "${gc_retry_case}/out" || fail "expected transient GC retry diagnostic"
grep -Fqx -- "$setup_command" "${gc_retry_case}/ssh.log" || fail "recovered GC must continue to runner setup"

gc_failure_case="${TMPDIR}/gc-failure"
prepare_remote_case "$gc_failure_case"
REMOTE_REACH_GC=1 REMOTE_GC_STATUSES=7 run_remote_case "$gc_failure_case"
[ "$(< "${gc_failure_case}/gc-count")" -eq 1 ] || fail "ordinary GC failure must not retry"
grep -Fq 'runner GC failed on dev-arm-1 with status 7' "${gc_failure_case}/out" || fail "expected ordinary GC failure status"
if grep -Fqx -- "$setup_command" "${gc_failure_case}/ssh.log"; then
  fail "failed GC must not continue to runner setup"
fi

gc_transport_failure_case="${TMPDIR}/gc-transport-failure"
prepare_remote_case "$gc_transport_failure_case"
REMOTE_REACH_GC=1 REMOTE_GC_STATUSES=255,255 \
  run_remote_case "$gc_transport_failure_case"
[ "$(< "${gc_transport_failure_case}/gc-count")" -eq 2 ] || fail "persistent SSH failure must stop after one GC retry"
[ "$(grep -Fxc -- "$gc_command" "${gc_transport_failure_case}/ssh.log")" -eq 2 ] || fail "persistent SSH attempts must invoke the runner directly"
grep -Fq 'runner GC failed on dev-arm-1 with status 255' "${gc_transport_failure_case}/out" || fail "expected final SSH failure status"
if grep -Fqx -- "$setup_command" "${gc_transport_failure_case}/ssh.log"; then
  fail "persistent SSH failure must not continue to runner setup"
fi

upload_success_case="${TMPDIR}/upload-success"
prepare_remote_case "$upload_success_case"
REMOTE_REACH_GC=1 REMOTE_GC_STATUSES=0 REMOTE_UPLOAD_STATUSES=0 \
  run_remote_case "$upload_success_case"
cmp "$runner" "${upload_success_case}/uploads/runner" || fail "successful upload must publish the complete executable"
[ "$(< "${upload_success_case}/upload-count")" -eq 1 ] || fail "healthy upload must run once"
grep -Fqx -- "$setup_command" "${upload_success_case}/ssh.log" || fail "validated upload must continue to setup"
grep -Fq 'runner upload completed: host=dev-arm-1 attempt=1/2 elapsed_seconds=' "${upload_success_case}/out" || fail "expected successful upload timing"

for status in 255 124 141; do
  upload_retry_case="${TMPDIR}/upload-retry-${status}"
  prepare_remote_case "$upload_retry_case"
  REMOTE_REACH_GC=1 REMOTE_GC_STATUSES=0 REMOTE_UPLOAD_STATUSES="${status},0" \
    run_remote_case "$upload_retry_case"
  [ "$(< "${upload_retry_case}/upload-count")" -eq 2 ] || fail "transient upload failure must retry once"
  cmp "$runner" "${upload_retry_case}/uploads/runner" || fail "retry must restart input and publish only the complete candidate"
  failed_candidate=$(< "${upload_retry_case}/uploads/failed-candidate")
  grep -Fxq 'late stale bytes' "$failed_candidate" || fail "expected a late write to the failed candidate"
  grep -Fqx -- "$setup_command" "${upload_retry_case}/ssh.log" || fail "recovered upload must continue to setup"
  [ "$(grep -c '^mutate mkdir ' "${upload_retry_case}/systemctl.log")" -eq 1 ] || fail "upload retry must not repeat destructive preparation"
  [ "$(< "${upload_retry_case}/gc-count")" -eq 1 ] || fail "upload retry must not repeat GC"
  grep -Fq "runner upload failed: host=dev-arm-1 attempt=1/2 status=${status} elapsed_seconds=" "${upload_retry_case}/out" || fail "expected original upload status and timing"
  grep -Fq "expected_bytes=${runner_size}" "${upload_retry_case}/out" || fail "expected upload size diagnostic"
  grep -Fq 'fixture transfer interrupted' "${upload_retry_case}/out" || fail "expected original upload stderr"
done

for statuses in 255,255 7 130 137 143; do
  upload_failure_case="${TMPDIR}/upload-failure-${statuses}"
  prepare_remote_case "$upload_failure_case"
  REMOTE_REACH_GC=1 REMOTE_UPLOAD_STATUSES="$statuses" \
    run_remote_case "$upload_failure_case"
  expected_attempts=1
  if [ "$statuses" = 255,255 ]; then expected_attempts=2; fi
  [ "$(< "${upload_failure_case}/upload-count")" -eq "$expected_attempts" ] || fail "upload failures must respect retry and cancellation boundaries"
  [ ! -e "${upload_failure_case}/uploads/runner" ] || fail "failed upload must not publish an executable"
  [ ! -e "${upload_failure_case}/manifest.json" ] || fail "failed upload must not publish a manifest"
  [ "$(< "${upload_failure_case}/gc-count")" -eq 0 ] || fail "failed upload must not reach GC"
  grep -Fq "attempt=${expected_attempts}/2 status=${statuses##*,}" "${upload_failure_case}/out" || fail "expected terminal upload status"
done

upload_corrupt_case="${TMPDIR}/upload-corrupt"
prepare_remote_case "$upload_corrupt_case"
REMOTE_REACH_GC=1 REMOTE_UPLOAD_STATUSES=0 REMOTE_UPLOAD_CORRUPT=1 \
  run_remote_case "$upload_corrupt_case"
grep -Fq 'runner sha mismatch' "${upload_corrupt_case}/out" || fail "successful SSH must not bypass checksum validation"
[ "$(< "${upload_corrupt_case}/upload-count")" -eq 1 ] || fail "checksum failure must not retry upload"
[ ! -e "${upload_corrupt_case}/uploads/runner" ] || fail "corrupt upload must not publish an executable"
[ -z "$(find "${upload_corrupt_case}/uploads" -type f -name 'runner.*')" ] || fail "verification failure must clean up its candidate"
[ ! -e "${upload_corrupt_case}/manifest.json" ] || fail "corrupt upload must not publish a manifest"
[ "$(< "${upload_corrupt_case}/gc-count")" -eq 0 ] || fail "corrupt upload must not reach GC"

okou_cli_dir="${TMPDIR}/okou-cli-artifact"
mkdir -p "$okou_cli_dir"
printf 'cli tarball fixture\n' > "${okou_cli_dir}/package.tgz"
okou_cli_sha=$(sha256sum "${okou_cli_dir}/package.tgz" | awk '{print $1}')
jq -n --arg sha "$okou_cli_sha" '{
  version: 1,
  commitSha: "abc",
  package: {path: "package.tgz", sha256: $sha, size: 20},
  versions: {cli: "9.353.0", piAgentRuntime: "1.36.0", piSdk: "0.86.1+okou.0123456789ab"}
}' > "${okou_cli_dir}/manifest.json"

okou_cli_case="${TMPDIR}/okou-cli-staged"
prepare_remote_case "$okou_cli_case"
OKOU_CLI_ARTIFACT_DIR="$okou_cli_dir" REMOTE_REACH_GC=1 REMOTE_GC_STATUSES=0 \
  run_remote_case "$okou_cli_case"
grep -Fqx -- 'ci@dev-arm-1 sudo mkdir -p /var/lib/vm0-runner/bin/pr-123/okou-cli' "${okou_cli_case}/ssh.log" || fail "CLI artifact staging must create the artifact directory"
for artifact_file in package.tgz manifest.json; do
  grep -Eq "^ci@dev-arm-1 sudo install -m 644 /dev/stdin /var/lib/vm0-runner/bin/pr-123/okou-cli/${artifact_file}\.abc\.1\.tmp\." "${okou_cli_case}/ssh.log" || fail "CLI artifact ${artifact_file} must upload through a private candidate"
done
grep -Fqx -- "$gc_command" "${okou_cli_case}/ssh.log" || fail "CLI artifact staging must precede GC"
grep -Fqx -- "$setup_command" "${okou_cli_case}/ssh.log" || fail "CLI artifact staging must continue to runner setup"
grep -Fq -- '--okou-cli-artifact "$OKOU_CLI_DIR"' "$PREPARE" || fail "runner build must receive the staged CLI artifact directory"

no_okou_cli_case="${TMPDIR}/okou-cli-absent"
prepare_remote_case "$no_okou_cli_case"
REMOTE_REACH_GC=1 REMOTE_GC_STATUSES=0 run_remote_case "$no_okou_cli_case"
if grep -q 'okou-cli' "${no_okou_cli_case}/ssh.log"; then
  fail "without OKOU_CLI_ARTIFACT_DIR no CLI artifact command may reach the host"
fi

printf 'tampered\n' > "${okou_cli_dir}/package.tgz"
if OKOU_CLI_ARTIFACT_DIR="$okou_cli_dir" \
  JOB_REF=pr-123 \
  HEAD_SHA=abc \
  METAL_HOSTS=dev-1 \
  METAL_USER=ci \
  TARGET_TRIPLE=aarch64-unknown-linux-musl \
  EXPECTED_REMOTE_ARCH=aarch64 \
  RUNNER_PATH="$runner" \
  FRESH_METADATA_PATH="$metadata" \
  EXPECTED_BINARY_INPUT_DIGEST="$input_digest" \
  "$PREPARE" >"${TMPDIR}/okou-cli-mismatch.out" 2>"${TMPDIR}/okou-cli-mismatch.err"; then
  fail "expected a CLI artifact whose package does not match its manifest to fail"
fi
grep -q "Okou CLI package sha mismatch" "${TMPDIR}/okou-cli-mismatch.err" || fail "expected CLI artifact sha mismatch message"

echo "prepare-runner-image-test: ok"
