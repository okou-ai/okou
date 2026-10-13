#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

RUNNER_GUEST_INVENTORY_PATH="${TMPDIR}/guests.json"
. "${SCRIPT_DIR}/runner/runner-guest-binaries.sh"

cat >"$RUNNER_GUEST_INVENTORY_PATH" <<'JSON'
[
  {
    "package": "guest-one",
    "binary": "guest-one",
    "pathEnv": "GUEST_ONE_PATH",
    "bundledEnv": "BUNDLED_GUEST_ONE",
    "destination": "/usr/local/bin/guest one"
  },
  {
    "package": "service-client",
    "binary": "guest-two",
    "pathEnv": "GUEST_TWO_PATH",
    "bundledEnv": "BUNDLED_GUEST_TWO",
    "destination": "/sbin/guest-two"
  }
]
JSON

runner_guest_binaries_load

[ "${#RUNNER_GUEST_PACKAGES[@]}" -eq 2 ] || fail "expected two guest packages"
[ "${RUNNER_GUEST_PACKAGES[0]}" = "guest-one" ] || fail "expected first package"
[ "${RUNNER_GUEST_PACKAGES[1]}" = "service-client" ] || fail "expected package independent of binary name"
[ "${RUNNER_GUEST_BINARIES[1]}" = "guest-two" ] || fail "expected second binary"
[ "${RUNNER_GUEST_PATH_ENVS[0]}" = "GUEST_ONE_PATH" ] || fail "expected first path env"

jq '.[0].bundledEnv = ""' "$RUNNER_GUEST_INVENTORY_PATH" >"${TMPDIR}/invalid.json"
RUNNER_GUEST_INVENTORY_PATH="${TMPDIR}/invalid.json"
if runner_guest_binaries_load >"${TMPDIR}/invalid.out" 2>"${TMPDIR}/invalid.err"; then
  fail "expected empty inventory field to fail"
fi
grep -q "runner guest inventory fields must be non-empty strings" "${TMPDIR}/invalid.err" || fail "expected invalid field error"

printf '[]\n' >"$RUNNER_GUEST_INVENTORY_PATH"
if runner_guest_binaries_load >"${TMPDIR}/empty.out" 2>"${TMPDIR}/empty.err"; then
  fail "expected empty inventory to fail"
fi
grep -q "runner guest inventory must be a non-empty array" "${TMPDIR}/empty.err" || fail "expected empty inventory error"

echo "runner-guest-binaries-test: ok"
