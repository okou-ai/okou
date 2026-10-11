#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DEV_RUNNER="${REPO_ROOT}/scripts/dev-runner.sh"
TARGET_HELPER="${REPO_ROOT}/.github/scripts/runner-image-target.sh"
GUEST_HELPER="${REPO_ROOT}/.github/scripts/runner-guest-binaries.sh"
GUEST_INVENTORY="${REPO_ROOT}/crates/runner/guest-binaries.json"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

setup_test_root() {
  local root=$1

  mkdir -p \
    "${root}/scripts" \
    "${root}/.github/scripts" \
    "${root}/.certs" \
    "${root}/crates/runner" \
    "${root}/bin"

  ln -s "$DEV_RUNNER" "${root}/scripts/dev-runner.sh"
  ln -s "$TARGET_HELPER" "${root}/.github/scripts/runner-image-target.sh"
  ln -s "$GUEST_HELPER" "${root}/.github/scripts/runner-guest-binaries.sh"
  ln -s "$GUEST_INVENTORY" "${root}/crates/runner/guest-binaries.json"
  touch "${root}/.certs/vm0-metal-local.pem"

  cat >"${root}/scripts/.env.local" <<'ENV'
RUNNER_LOCAL_HOST=dev-host
RUNNER_LOCAL_USER=ubuntu
RUNNER_DEFAULT_GROUP=vm0/local-test
OFFICIAL_RUNNER_SECRET=test-secret
ENV

  cat >"${root}/scripts/cf-ssh.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

command="${*: -1}"
printf '%s\n' "$command" >>"${CF_SSH_LOG:?}"

case "$command" in
  "uname -m")
    printf '%s\n' "${REMOTE_ARCH:?}"
    ;;
  *"service stop"*)
    printf '%s\n' "$command" >>"${SERVICE_STOP_LOG:?}"
    ;;
  "sudo mkdir -p "*)
    ;;
  "sudo install -m 755 /dev/stdin "*)
    cat >/dev/null
    ;;
  *" setup")
    ;;
  *" gc --keep-latest 3")
    ;;
  *" build --profile "*)
    printf '%s\n' "rootfs_hash=rootfs-test"
    printf '%s\n' "snapshot_hash=snapshot-test"
    ;;
  *" config "*)
    ;;
  *" service start "*)
    ;;
  *" service wait-running "*)
    case "${READINESS_RESULT:-success}" in
      success)
        printf '%s\n' "4"
        ;;
      inactive)
        echo "vm0-runner-local-test.service is not active while waiting for running" >&2
        exit 1
        ;;
      timeout)
        echo "timed out waiting 120s for vm0-runner-local-test.service to reach running" >&2
        exit 1
        ;;
      *)
        echo "unexpected readiness result: $READINESS_RESULT" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    echo "unexpected cf-ssh command: $command" >&2
    exit 2
    ;;
esac
SH
  chmod +x "${root}/scripts/cf-ssh.sh"

  cat >"${root}/bin/cargo" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

target=""
packages=()
original_args="$*"
while (($#)); do
  case "$1" in
    --target)
      target="$2"
      shift 2
      ;;
    -p)
      packages+=("$2")
      shift 2
      ;;
    *) shift ;;
  esac
done

if [ -z "$target" ]; then
  echo "missing fake cargo target" >&2
  exit 2
fi

printf '%s\n' "$original_args" >>"${CARGO_LOG:?}"
mkdir -p "target/${target}/ci"
for bin in "${packages[@]}"; do
  printf '%s\n' "$bin" >"target/${target}/ci/${bin}"
  chmod +x "target/${target}/ci/${bin}"
done
SH
  chmod +x "${root}/bin/cargo"
}

run_deploy() {
  local name=$1
  local remote_arch=$2
  shift 2

  local root="${TMPDIR}/${name}"
  setup_test_root "$root"

  REMOTE_ARCH="$remote_arch" \
    CF_SSH_LOG="${root}/cf-ssh.log" \
    SERVICE_STOP_LOG="${root}/service-stop.log" \
    CARGO_LOG="${root}/cargo.log" \
    PATH="${root}/bin:$PATH" \
    "$@" "${root}/scripts/dev-runner.sh" deploy
}

run_deploy arm64-success aarch64 env >"${TMPDIR}/arm64-success.out" 2>"${TMPDIR}/arm64-success.err"
grep -q -- "--target aarch64-unknown-linux-musl" "${TMPDIR}/arm64-success/cargo.log" || fail "expected ARM64 cargo target"
grep -q "service stop" "${TMPDIR}/arm64-success/service-stop.log" || fail "expected ARM64 service stop"

run_deploy x86-success x86_64 env >"${TMPDIR}/x86-success.out" 2>"${TMPDIR}/x86-success.err"
grep -q -- "--target x86_64-unknown-linux-musl" "${TMPDIR}/x86-success/cargo.log" || fail "expected x86_64 cargo target"
grep -q "service stop" "${TMPDIR}/x86-success/service-stop.log" || fail "expected x86_64 service stop"
grep -q -- "--hostname dev-host" "${TMPDIR}/x86-success/cf-ssh.log" || fail "expected config hostname"
gc_command=$(grep " gc --keep-latest 3$" "${TMPDIR}/x86-success/cf-ssh.log")
[[ "$gc_command" != *"R2_"* ]] || fail "gc should not receive R2 credentials"
build_command=$(grep " build --profile vm0/default$" "${TMPDIR}/x86-success/cf-ssh.log")
[[ "$build_command" == *"R2_ACCOUNT_ID="* ]] || fail "build should retain R2 credentials"
grep -q " service wait-running --name local-test --timeout-secs 120$" "${TMPDIR}/x86-success/cf-ssh.log" || fail "expected readiness command"
start_line=$(grep -n " service start " "${TMPDIR}/x86-success/cf-ssh.log" | cut -d: -f1)
readiness_line=$(grep -n " service wait-running " "${TMPDIR}/x86-success/cf-ssh.log" | cut -d: -f1)
[ "$start_line" -lt "$readiness_line" ] || fail "readiness should follow service start"
grep -q "\[runner\] Waiting for Runner readiness..." "${TMPDIR}/x86-success.err" || fail "expected readiness progress"
grep -q "\[runner\] Done! Runner service local-test deployed to dev-host" "${TMPDIR}/x86-success.err" || fail "expected completion after readiness"
if grep -q '^4$' "${TMPDIR}/x86-success.out"; then
  fail "readiness capacity should not be printed"
fi

if run_deploy readiness-inactive x86_64 env READINESS_RESULT=inactive >"${TMPDIR}/readiness-inactive.out" 2>"${TMPDIR}/readiness-inactive.err"; then
  fail "expected inactive Runner readiness to fail"
fi
grep -q "is not active while waiting for running" "${TMPDIR}/readiness-inactive.err" || fail "expected inactive Runner diagnostic"
if grep -q "\[runner\] Done!" "${TMPDIR}/readiness-inactive.err"; then
  fail "inactive Runner should not report completion"
fi

if run_deploy readiness-timeout x86_64 env READINESS_RESULT=timeout >"${TMPDIR}/readiness-timeout.out" 2>"${TMPDIR}/readiness-timeout.err"; then
  fail "expected Runner readiness timeout to fail"
fi
grep -q "timed out waiting 120s" "${TMPDIR}/readiness-timeout.err" || fail "expected Runner readiness timeout diagnostic"
if grep -q "\[runner\] Done!" "${TMPDIR}/readiness-timeout.err"; then
  fail "timed out Runner should not report completion"
fi

run_deploy x86-explicit-success x86_64 env RUNNER_TARGET_TRIPLE=x86_64-unknown-linux-musl >"${TMPDIR}/x86-explicit-success.out" 2>"${TMPDIR}/x86-explicit-success.err"
grep -q -- "--target x86_64-unknown-linux-musl" "${TMPDIR}/x86-explicit-success/cargo.log" || fail "expected explicit x86_64 cargo target"

if run_deploy mismatch x86_64 env RUNNER_TARGET_TRIPLE=aarch64-unknown-linux-musl >"${TMPDIR}/mismatch.out" 2>"${TMPDIR}/mismatch.err"; then
  fail "expected target mismatch to fail"
fi
[ ! -f "${TMPDIR}/mismatch/cargo.log" ] || fail "target mismatch should fail before cargo"
[ ! -f "${TMPDIR}/mismatch/service-stop.log" ] || fail "target mismatch should fail before service stop"
grep -q "expects remote architecture aarch64, but dev-host reported x86_64" "${TMPDIR}/mismatch.err" || fail "expected mismatch error"

if run_deploy invalid-override aarch64 env RUNNER_TARGET_TRIPLE=powerpc-unknown-linux-musl >"${TMPDIR}/invalid-override.out" 2>"${TMPDIR}/invalid-override.err"; then
  fail "expected invalid target override to fail"
fi
[ ! -f "${TMPDIR}/invalid-override/cargo.log" ] || fail "invalid target override should fail before cargo"
[ ! -f "${TMPDIR}/invalid-override/service-stop.log" ] || fail "invalid target override should fail before service stop"
[ ! -f "${TMPDIR}/invalid-override/cf-ssh.log" ] || fail "invalid target override should fail before ssh"
grep -q "unsupported runner image target: powerpc-unknown-linux-musl" "${TMPDIR}/invalid-override.err" || fail "expected invalid target override error"

if run_deploy unsupported ppc64le env >"${TMPDIR}/unsupported.out" 2>"${TMPDIR}/unsupported.err"; then
  fail "expected unsupported remote architecture to fail"
fi
[ ! -f "${TMPDIR}/unsupported/cargo.log" ] || fail "unsupported architecture should fail before cargo"
[ ! -f "${TMPDIR}/unsupported/service-stop.log" ] || fail "unsupported architecture should fail before service stop"
grep -q "unsupported remote architecture for dev-host: ppc64le" "${TMPDIR}/unsupported.err" || fail "expected unsupported architecture error"

echo "dev-runner-test: ok"
