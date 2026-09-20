#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BUILD="${SCRIPT_DIR}/runner-release-build.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

mkdir -p "${TMPDIR}/bin"
cat > "${TMPDIR}/inventory.json" <<'JSON'
[
  {
    "package": "guest-one",
    "binary": "guest-one",
    "pathEnv": "GUEST_ONE_PATH",
    "bundledEnv": "BUNDLED_GUEST_ONE",
    "destination": "/usr/local/bin/guest-one"
  },
  {
    "package": "service-client",
    "binary": "service-client",
    "pathEnv": "SERVICE_CLIENT_PATH",
    "bundledEnv": "BUNDLED_SERVICE_CLIENT",
    "destination": "/usr/local/bin/service-client"
  }
]
JSON

cat > "${TMPDIR}/bin/cargo" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
printf 'pwd=%s args=%s guest=%s service=%s\n' \
  "$PWD" \
  "$*" \
  "${GUEST_ONE_PATH:-}" \
  "${SERVICE_CLIENT_PATH:-}" >> "$FAKE_CARGO_LOG"
BASH
chmod +x "${TMPDIR}/bin/cargo"

run_build() {
  env \
    "FAKE_CARGO_LOG=${TMPDIR}/cargo.log" \
    "PATH=${TMPDIR}/bin:${PATH}" \
    "RUNNER_GUEST_INVENTORY_PATH=${TMPDIR}/inventory.json" \
    "TARGET_TRIPLE=aarch64-unknown-linux-musl" \
    "$BUILD" "$@"
}

run_build guests
run_build runner

mapfile -t cargo_calls < "${TMPDIR}/cargo.log"
[ "${#cargo_calls[@]}" -eq 2 ] || fail "expected exactly two Cargo calls"
[ "${cargo_calls[0]}" = "pwd=${REPO_ROOT}/crates args=build --release --target aarch64-unknown-linux-musl -p guest-one -p service-client guest= service=" ] || \
  fail "guest compilation did not preserve release package arguments: ${cargo_calls[0]}"
[ "${cargo_calls[1]}" = "pwd=${REPO_ROOT}/crates args=build --release --target aarch64-unknown-linux-musl -p runner guest=target/aarch64-unknown-linux-musl/release/guest-one service=target/aarch64-unknown-linux-musl/release/service-client" ] || \
  fail "Runner compilation did not preserve embedded guest paths: ${cargo_calls[1]}"

if env \
  "PATH=${TMPDIR}/bin:${PATH}" \
  "RUNNER_GUEST_INVENTORY_PATH=${TMPDIR}/inventory.json" \
  "TARGET_TRIPLE=powerpc-unknown-linux-musl" \
  "$BUILD" guests >"${TMPDIR}/unsupported.out" 2>"${TMPDIR}/unsupported.err"; then
  fail "unsupported target must fail before compilation"
fi
grep -q "unsupported runner image target: powerpc-unknown-linux-musl" "${TMPDIR}/unsupported.err" || \
  fail "unsupported target must report the target contract"

if env \
  "PATH=${TMPDIR}/bin:${PATH}" \
  "$BUILD" invalid >"${TMPDIR}/mode.out" 2>"${TMPDIR}/mode.err"; then
  fail "unknown release build mode must fail"
fi
grep -q "usage: .* <guests|runner>" "${TMPDIR}/mode.err" || fail "unknown mode must report usage"

echo "runner release build tests passed"
