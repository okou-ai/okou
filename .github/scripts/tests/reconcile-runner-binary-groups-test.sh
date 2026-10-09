#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${SCRIPT_DIR}/reconcile-runner-binary-groups.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
FAKE_BIN="${TMP_DIR}/bin"
REMOTE_ROOT="${TMP_DIR}/remote"
RECOVERY_DIR="${TMP_DIR}/recovery"
mkdir -p "$FAKE_BIN" "$REMOTE_ROOT/arm-1" "$REMOTE_ROOT/x86-1" "$RECOVERY_DIR"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

cat >"${FAKE_BIN}/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "-n" ]; then
  shift
fi
remote=${1:-}
shift
host=${remote#*@}
host_root="${MOCK_REMOTE_ROOT}/${host}"
mkdir -p "$host_root"

if [ "${1:-}" = "uname" ] && [ "${2:-}" = "-m" ]; then
  case "$host" in
    arm-1) echo aarch64 ;;
    x86-1) echo x86_64 ;;
    *) echo "unexpected host: ${host}" >&2; exit 1 ;;
  esac
  exit 0
fi

if [ "${1:-}" = "sudo" ] && [ "${2:-}" = "mkdir" ]; then
  exit 0
fi

if [ "${1:-}" = "sudo" ] && [ "${2:-}" = "install" ]; then
  destination=${6:-}
  [ -n "$destination" ] || { echo "missing install destination" >&2; exit 1; }
  cat >"${host_root}/$(basename "$destination")"
  chmod 755 "${host_root}/$(basename "$destination")"
  printf '%s\n' "$host" >>"$MOCK_INSTALL_LOG"
  exit 0
fi

if [ "${1:-}" = "bash" ] && [ "${2:-}" = "-s" ] && [ "${3:-}" = "--" ]; then
  shift 3
  case "$#" in
    1)
      runner_path="${host_root}/runner"
      if [ ! -x "$runner_path" ]; then
        echo missing
      else
        sha256sum "$runner_path" | awk '{print $1}'
      fi
      ;;
    3)
      tmp_runner="${host_root}/$(basename "$1")"
      expected_sha=$3
      actual_sha=$(sha256sum "$tmp_runner" | awk '{print $1}')
      if [ "$actual_sha" != "$expected_sha" ]; then
        echo "runner recovery SHA mismatch: ${actual_sha} != ${expected_sha}" >&2
        exit 1
      fi
      "$tmp_runner" --version >/dev/null
      mv -f "$tmp_runner" "${host_root}/runner"
      ;;
    *)
      echo "unexpected remote bash arguments: $*" >&2
      exit 1
      ;;
  esac
  exit 0
fi

echo "unexpected ssh command for ${host}: $*" >&2
exit 1
SH
chmod +x "${FAKE_BIN}/ssh"

make_transport() {
  local target=$1 marker=$2
  local target_dir="${RECOVERY_DIR}/${target}"
  mkdir -p "$target_dir"
  cat >"${target_dir}/runner" <<SH
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then
  echo "fake-runner-${marker}"
  exit 0
fi
exit 1
SH
  chmod +x "${target_dir}/runner"

  local digest size sha toolchain
  digest=$(env GITHUB_OUTPUT= "${SCRIPT_DIR}/runner-binary-build/digest.sh" "$target" |
    sed -n 's/^binary-input-digest=//p' | tail -n1)
  size=$(stat -c '%s' "${target_dir}/runner")
  sha=$(sha256sum "${target_dir}/runner" | awk '{print $1}')
  # shellcheck disable=SC1091
  . "${SCRIPT_DIR}/runner-binary-build/contract.env"
  toolchain=$RUNNER_BINARY_TOOLCHAIN_IMAGE
  jq -n \
    --arg digest "$digest" \
    --arg target "$target" \
    --arg toolchain "$toolchain" \
    --arg sha "$sha" \
    --argjson size "$size" '
      {
        schemaVersion: 1,
        binaryInputDigest: $digest,
        target: $target,
        toolchainImage: $toolchain,
        runnerSha256: $sha,
        runnerSizeBytes: $size,
        guestSha256: {
          "guest-agent": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "guest-storage-apply": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "guest-init": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "claude-mock": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          "codex-mock": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          "guest-state-restore": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          "guest-tool-exec": "2222222222222222222222222222222222222222222222222222222222222222",
          "runner-rpc-client": "2222222222222222222222222222222222222222222222222222222222222222",
          "guest-write-file": "1111111111111111111111111111111111111111111111111111111111111111",
          "guest-home-mount": "3333333333333333333333333333333333333333333333333333333333333333"
        }
      }
    ' >"${target_dir}/metadata.json"
}

ARM_TARGET=aarch64-unknown-linux-musl
X86_TARGET=x86_64-unknown-linux-musl
make_transport "$ARM_TARGET" arm
make_transport "$X86_TARGET" x86
ARM_SHA=$(sha256sum "${RECOVERY_DIR}/${ARM_TARGET}/runner" | awk '{print $1}')
X86_SHA=$(sha256sum "${RECOVERY_DIR}/${X86_TARGET}/runner" | awk '{print $1}')
RUNNER_SHA_MAP=$(jq -n -c \
  --arg arm "$ARM_SHA" \
  --arg x86 "$X86_SHA" \
  '{"aarch64-unknown-linux-musl": $arm, "x86_64-unknown-linux-musl": $x86}')

cp "${RECOVERY_DIR}/${ARM_TARGET}/runner" "${REMOTE_ROOT}/arm-1/runner"
chmod +x "${REMOTE_ROOT}/arm-1/runner"
INSTALL_LOG="${TMP_DIR}/install.log"
: >"$INSTALL_LOG"

run_reconcile() {
  PATH="${FAKE_BIN}:$PATH" \
    AWS_METAL_RUNNER_HOSTS=arm-1,x86-1 \
    METAL_USER=ci \
    JOB_REF=pr-42 \
    BIN_DIR="${TEST_BIN_DIR:-/var/lib/vm0-runner/bin/pr-42}" \
    RUNNER_SHA_MAP="$RUNNER_SHA_MAP" \
    RECOVERY_DIR="$RECOVERY_DIR" \
    MOCK_REMOTE_ROOT="$REMOTE_ROOT" \
    MOCK_INSTALL_LOG="$INSTALL_LOG" \
    GITHUB_RUN_ID=1234 \
    "$SCRIPT" "$@"
}

check_output="${TMP_DIR}/check.out"
GITHUB_OUTPUT="$check_output" run_reconcile check >/dev/null
grep -qxF 'recovery-needed=true' "$check_output" || fail "missing binary must require recovery"
grep -qxF "recovery-targets=[\"${X86_TARGET}\"]" "$check_output" ||
  fail "check must identify only the missing target"
grep -q 'runner-host-groups-matrix=' "$check_output" ||
  fail "check must expose the validated cache-plan matrix"

run_reconcile restore >/dev/null
[ "$(cat "$INSTALL_LOG")" = "x86-1" ] || fail "restore must install only on the missing host"
[ "$(sha256sum "${REMOTE_ROOT}/x86-1/runner" | awk '{print $1}')" = "$X86_SHA" ] ||
  fail "restored x86 runner must match the image manifest"

check_output="${TMP_DIR}/healthy.out"
GITHUB_OUTPUT="$check_output" run_reconcile check >/dev/null
grep -qxF 'recovery-needed=false' "$check_output" || fail "matching binaries must not use recovery"

printf 'corrupt runner\n' >"${REMOTE_ROOT}/arm-1/runner"
chmod +x "${REMOTE_ROOT}/arm-1/runner"
: >"$INSTALL_LOG"
run_reconcile restore >/dev/null
[ "$(cat "$INSTALL_LOG")" = "arm-1" ] || fail "SHA mismatch must restore only the affected host"
[ "$(sha256sum "${REMOTE_ROOT}/arm-1/runner" | awk '{print $1}')" = "$ARM_SHA" ] ||
  fail "restored arm runner must match the image manifest"

rm -f "${REMOTE_ROOT}/x86-1/runner"
: >"$INSTALL_LOG"
GOOD_SHA_MAP=$RUNNER_SHA_MAP
RUNNER_SHA_MAP=$(jq -c \
  '."x86_64-unknown-linux-musl" = "2222222222222222222222222222222222222222222222222222222222222222"' \
  <<<"$RUNNER_SHA_MAP")
if run_reconcile restore >"${TMP_DIR}/mismatch.out" 2>"${TMP_DIR}/mismatch.err"; then
  fail "transport that disagrees with the producer manifest must fail closed"
fi
grep -q 'validated runner transport does not match image manifest' "${TMP_DIR}/mismatch.err" ||
  fail "manifest mismatch must report the validation boundary"
[ ! -s "$INSTALL_LOG" ] || fail "manifest mismatch must not install a runner binary"
RUNNER_SHA_MAP=$GOOD_SHA_MAP

if TEST_BIN_DIR=/var/lib/vm0-runner/bin/pr-99 run_reconcile check >/dev/null 2>&1; then
  fail "runner binary path outside the manifest job ref must fail closed"
fi

echo "reconcile-runner-binary-groups-test: ok"
