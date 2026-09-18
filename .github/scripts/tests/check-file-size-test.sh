#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/scripts/check-file-size.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

ordinary_file="${tmp_dir}/ordinary.bin"
snapshot_dir="${tmp_dir}/packages/db/src/migrations/meta"
snapshot_file="${snapshot_dir}/0001_snapshot.json"
journal_file="${snapshot_dir}/_journal.json"
invalid_snapshot_file="${snapshot_dir}/001_snapshot.json"
mkdir -p "$snapshot_dir"

set_size() {
  local path="$1"
  local size="$2"
  dd if=/dev/zero of="$path" bs=1 count=0 seek="$size" 2>/dev/null
}

expect_pass() {
  if ! bash "$script" "$@" >/dev/null; then
    echo "Expected file-size check to pass: $*" >&2
    exit 1
  fi
}

expect_fail() {
  local output
  if output="$(bash "$script" "$@" 2>&1)"; then
    echo "Expected file-size check to fail: $*" >&2
    exit 1
  fi
  case "$output" in
    *"limit: 1MB"* | *"limit: 4MB"*) ;;
    *)
      echo "Expected failure output to report the applicable limit" >&2
      echo "$output" >&2
      exit 1
      ;;
  esac
}

set_size "$ordinary_file" 1048576
expect_pass "$ordinary_file"
set_size "$ordinary_file" 1048577
expect_fail "$ordinary_file"

set_size "$snapshot_file" 4194304
expect_pass "$snapshot_file"
set_size "$snapshot_file" 4194305
expect_fail "$snapshot_file"

set_size "$journal_file" 1048577
expect_fail "$journal_file"
set_size "$invalid_snapshot_file" 1048577
expect_fail "$invalid_snapshot_file"

(
  cd "$tmp_dir"
  set_size "packages/db/src/migrations/meta/0001_snapshot.json" 2097152
  expect_pass "packages/db/src/migrations/meta/0001_snapshot.json"
)

expect_pass "${tmp_dir}/deleted-file.bin"
ALLOW_LARGE_FILES=1 bash "$script" "$ordinary_file" >/dev/null
bash "$script" >/dev/null

echo "check-file-size tests passed"
