#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHANGED_BASE_REF="${SCRIPT_DIR}/checks/changed-base-ref.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_eq() {
  local actual=$1 expected=$2
  if [ "$actual" != "$expected" ]; then
    fail "expected '${expected}', got '${actual}'"
  fi
}

run_clean() {
  env -i PATH="$PATH" HOME="${HOME:-/tmp}" "$@"
}

repo="${TMPDIR}/repo"
mkdir "$repo"
git -C "$repo" init -q -b main
git -C "$repo" config user.email test@example.com
git -C "$repo" config user.name Test

mkdir -p "$repo/crates" "$repo/turbo"
echo base > "$repo/README.md"
git -C "$repo" add README.md
git -C "$repo" commit -q -m "base"
event_base=$(git -C "$repo" rev-parse HEAD)

git -C "$repo" switch -q -c feature
echo rust > "$repo/crates/lib.rs"
git -C "$repo" add crates/lib.rs
git -C "$repo" commit -q -m "feature"
feature_head=$(git -C "$repo" rev-parse HEAD)

git -C "$repo" switch -q main
echo turbo > "$repo/turbo/file.ts"
git -C "$repo" add turbo/file.ts
git -C "$repo" commit -q -m "main advance"
merge_parent=$(git -C "$repo" rev-parse HEAD)

git -C "$repo" switch -q -c pull-merge
git -C "$repo" merge -q --no-ff feature -m "merge feature"

actual=$(
  cd "$repo"
  run_clean \
    GITHUB_EVENT_NAME=pull_request \
    CHECKOUT_REF=refs/pull/123/merge \
    PULL_REQUEST_BASE_SHA="$event_base" \
    "$CHANGED_BASE_REF"
)
assert_eq "$actual" "$merge_parent"

git -C "$repo" switch -q --detach "$feature_head"
actual=$(
  cd "$repo"
  run_clean \
    GITHUB_EVENT_NAME=pull_request \
    CHECKOUT_REF=refs/heads/feature \
    PULL_REQUEST_BASE_SHA="$event_base" \
    "$CHANGED_BASE_REF"
)
assert_eq "$actual" "$event_base"

git -C "$repo" switch -q -C merge-group "$merge_parent"
git -C "$repo" cherry-pick "$feature_head" >/dev/null
merge_group_head=$(git -C "$repo" rev-parse HEAD)

actual=$(
  cd "$repo"
  run_clean \
    GITHUB_EVENT_NAME=merge_group \
    MERGE_GROUP_BASE_SHA="$merge_parent" \
    "$CHANGED_BASE_REF"
)
assert_eq "$actual" "$merge_parent"

missing_base=0000000000000000000000000000000000000000
if output=$(
  cd "$repo"
  run_clean \
    GITHUB_EVENT_NAME=merge_group \
    MERGE_GROUP_BASE_SHA="$missing_base" \
    "$CHANGED_BASE_REF" 2>&1
); then
  fail "expected unavailable merge-group base to fail"
fi
[[ "$output" == *"MERGE_GROUP_BASE_SHA is not an available commit: $missing_base"* ]] ||
  fail "unexpected unavailable merge-group base error: $output"

if output=$(
  cd "$repo"
  run_clean \
    GITHUB_EVENT_NAME=merge_group \
    MERGE_GROUP_BASE_SHA="$event_base" \
    "$CHANGED_BASE_REF" 2>&1
); then
  fail "expected non-parent merge-group base to fail"
fi
[[ "$output" == *"MERGE_GROUP_BASE_SHA does not match merge_group HEAD parent"* ]] ||
  fail "unexpected non-parent merge-group base error: $output"

actual=$(
  cd "$repo"
  run_clean GITHUB_EVENT_NAME=push "$CHANGED_BASE_REF"
)
assert_eq "$actual" "HEAD^"

changed_files=$(git -C "$repo" diff --name-only "$merge_parent" "$merge_group_head")
assert_eq "$changed_files" "crates/lib.rs"

echo "changed-base-ref-test: ok"
