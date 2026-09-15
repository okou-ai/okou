#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="${SCRIPT_DIR}/runner-image-manifest.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_contains() {
  local output=$1 expected=$2
  grep -qxF "$expected" <<<"$output" || fail "expected line '${expected}' in output: ${output}"
}

cat > "${TMPDIR}/manifest.json" <<'JSON'
{
  "schemaVersion": 1,
  "headSha": "abc",
  "jobRef": "pr-123",
  "target": "aarch64-unknown-linux-musl",
  "profile": "vm0/default",
  "binDir": "/var/lib/vm0-runner/bin/pr-123",
  "runnerDir": "/var/lib/vm0-runner/runners/pr-123",
  "runnerSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "guestSha256": {
    "guest-agent": "a",
    "guest-storage-apply": "b",
    "guest-init": "c",
    "claude-mock": "d",
    "codex-mock": "e",
    "guest-state-restore": "f",
    "guest-tool-exec": "h",
    "runner-rpc-client": "i",
    "guest-write-file": "g",
    "guest-workspace-mount": "j"
  },
  "hosts": {
    "dev-1": {
      "rootfsHash": "rootfs-1",
      "snapshotHash": "snapshot-1",
      "completedAt": "2026-05-11T00:00:00Z"
    },
    "dev-2": {
      "rootfsHash": "rootfs-2",
      "snapshotHash": "snapshot-2",
      "completedAt": "2026-05-11T00:00:00Z"
    }
  }
}
JSON

out=$(MANIFEST_PATH="${TMPDIR}/manifest.json" \
  HEAD_SHA=abc \
  JOB_REF=pr-123 \
  TARGET=aarch64-unknown-linux-musl \
  PROFILE=vm0/default \
  METAL_HOSTS=dev-1,dev-2 \
  SELECTED_HOST=dev-2 \
  "$MANIFEST" validate)
assert_contains "$out" "bin-dir=/var/lib/vm0-runner/bin/pr-123"
assert_contains "$out" "runner-sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
assert_contains "$out" 'rootfs-hash-map={"dev-1":"rootfs-1","dev-2":"rootfs-2"}'
assert_contains "$out" "selected-rootfs-hash=rootfs-2"
assert_contains "$out" "selected-snapshot-hash=snapshot-2"

if MANIFEST_PATH="${TMPDIR}/manifest.json" \
  HEAD_SHA=wrong \
  JOB_REF=pr-123 \
  TARGET=aarch64-unknown-linux-musl \
  PROFILE=vm0/default \
  METAL_HOSTS=dev-1 \
  "$MANIFEST" validate >"${TMPDIR}/manifest-test.out" 2>"${TMPDIR}/manifest-test.err"; then
  fail "expected wrong HEAD_SHA to fail"
fi
grep -q "headSha mismatch" "${TMPDIR}/manifest-test.err" || fail "expected headSha mismatch"

if MANIFEST_PATH="${TMPDIR}/manifest.json" \
  HEAD_SHA=abc \
  JOB_REF=pr-123 \
  TARGET=aarch64-unknown-linux-musl \
  PROFILE=vm0/default \
  METAL_HOSTS=dev-3 \
  "$MANIFEST" validate >"${TMPDIR}/manifest-test.out" 2>"${TMPDIR}/manifest-test.err"; then
  fail "expected missing host to fail"
fi
grep -q "manifest missing rootfsHash for dev-3" "${TMPDIR}/manifest-test.err" || fail "expected missing host message"

# Selecting an existing host must not bypass validation of its whole group.
if MANIFEST_PATH="${TMPDIR}/manifest.json" \
  HEAD_SHA=abc \
  JOB_REF=pr-123 \
  TARGET=aarch64-unknown-linux-musl \
  PROFILE=vm0/default \
  METAL_HOSTS=dev-1,dev-3 \
  SELECTED_HOST=dev-1 \
  "$MANIFEST" validate >"${TMPDIR}/selected-group.out" 2>"${TMPDIR}/selected-group.err"; then
  fail "expected missing unselected host in selected group to fail"
fi
grep -q "manifest missing rootfsHash for dev-3" "${TMPDIR}/selected-group.err" || fail "expected whole selected group validation"

if MANIFEST_PATH="${TMPDIR}/manifest.json" \
  HEAD_SHA=abc \
  JOB_REF=pr-123 \
  TARGET=x86_64-unknown-linux-musl \
  PROFILE=vm0/default \
  METAL_HOSTS=dev-1 \
  "$MANIFEST" validate >"${TMPDIR}/manifest-test.out" 2>"${TMPDIR}/manifest-test.err"; then
  fail "expected target mismatch to fail"
fi
grep -q "target mismatch: aarch64-unknown-linux-musl != x86_64-unknown-linux-musl" "${TMPDIR}/manifest-test.err" || fail "expected target mismatch"

if MANIFEST_PATH="${TMPDIR}/manifest.json" \
  HEAD_SHA=abc \
  JOB_REF=pr-123 \
  TARGET=powerpc-unknown-linux-musl \
  PROFILE=vm0/default \
  METAL_HOSTS=dev-1 \
  "$MANIFEST" validate >"${TMPDIR}/manifest-test.out" 2>"${TMPDIR}/manifest-test.err"; then
  fail "expected unsupported target to fail"
fi
grep -q "unsupported runner image target: powerpc-unknown-linux-musl" "${TMPDIR}/manifest-test.err" || fail "expected unsupported target message"

echo "runner-image-manifest-test: ok"
