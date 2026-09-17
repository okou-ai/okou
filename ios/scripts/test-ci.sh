#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source_root=$(git -C "$script_dir" rev-parse --show-toplevel)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT
repo="$test_root/repo"
git init --quiet --initial-branch=main "$repo"
git -C "$repo" config user.name "iOS CI Test"
git -C "$repo" config user.email "ios-ci@example.invalid"
git -C "$repo" config commit.gpgsign false
mkdir -p "$repo/.github/scripts" "$repo/.github/workflows" "$repo/ios" "$repo/turbo"
cp "$source_root/.github/scripts/changed-base-ref.sh" "$repo/.github/scripts/"
cd "$repo"

commit() {
  git add --all
  git commit --quiet -m "$1"
}
detect() {
  env -u EVENT_NAME -u CHECKOUT_REF -u PULL_REQUEST_BASE_SHA \
    -u MERGE_GROUP_BASE_SHA -u PUSH_BEFORE_SHA "$@" bash "$script_dir/ci-changed.sh"
}
expect() {
  local expected=$1
  shift
  local actual
  actual=$(detect "$@")
  if [ "$actual" != "$expected" ]; then
    echo "Expected iOS check selection $expected, got $actual" >&2
    exit 1
  fi
}
reject() {
  if detect "$@" > "$test_root/rejected.log" 2>&1; then
    echo "Expected change detection to reject invalid input" >&2
    exit 1
  fi
}

echo original > ios/App.swift
echo original > turbo/app.ts
commit base
base=$(git rev-parse HEAD)

# A PR merge must exclude unrelated iOS changes that landed on main meanwhile.
git switch --quiet -c unrelated-pr
echo changed > turbo/app.ts
commit unrelated
pr_head=$(git rev-parse HEAD)
git switch --quiet main
echo main-change > ios/App.swift
commit main-advanced
git switch --quiet -c pull-merge
git merge --quiet --no-ff unrelated-pr -m merge
expect false EVENT_NAME=pull_request CHECKOUT_REF=refs/pull/1/merge PULL_REQUEST_BASE_SHA="$base"

# A direct PR head still uses the supplied PR base and its merge base.
git switch --quiet --detach "$pr_head"
expect false EVENT_NAME=pull_request CHECKOUT_REF=refs/heads/unrelated-pr PULL_REQUEST_BASE_SHA="$base"
git switch --quiet -c ios-pr "$base"
echo ios-change > ios/App.swift
commit ios-change
expect true EVENT_NAME=pull_request CHECKOUT_REF=refs/heads/ios-pr PULL_REQUEST_BASE_SHA="$base"

# An iOS change earlier in a multi-entry merge group/main push must not disappear.
echo later > turbo/app.ts
commit later-unrelated-change
expect true EVENT_NAME=merge_group MERGE_GROUP_BASE_SHA="$base"
expect true EVENT_NAME=push PUSH_BEFORE_SHA="$base"
expect false EVENT_NAME=push PUSH_BEFORE_SHA="$(git rev-parse HEAD^)"
expect true EVENT_NAME=workflow_dispatch

# Deletions and renames across the iOS boundary also select checks.
before_delete=$(git rev-parse HEAD)
git rm --quiet ios/App.swift
commit delete-ios
expect true EVENT_NAME=push PUSH_BEFORE_SHA="$before_delete"
mkdir -p ios
echo moved > ios/Move.swift
commit add-move-source
before_move=$(git rev-parse HEAD)
git mv ios/Move.swift turbo/Move.swift
commit move-outside-ios
expect true EVENT_NAME=push PUSH_BEFORE_SHA="$before_move"
before_move=$(git rev-parse HEAD)
mkdir -p ios
git mv turbo/Move.swift ios/Move.swift
commit move-inside-ios
expect true EVENT_NAME=push PUSH_BEFORE_SHA="$before_move"

before_workflow=$(git rev-parse HEAD)
echo workflow > .github/workflows/ios.yml
commit own-workflow
expect true EVENT_NAME=push PUSH_BEFORE_SHA="$before_workflow"
before_helper=$(git rev-parse HEAD)
echo '# Shared base detection changed.' >> .github/scripts/changed-base-ref.sh
commit shared-helper
expect true EVENT_NAME=push PUSH_BEFORE_SHA="$before_helper"
expect false EVENT_NAME=push PUSH_BEFORE_SHA="$(git rev-parse HEAD)"
reject EVENT_NAME=merge_group MERGE_GROUP_BASE_SHA=missing-ref
reject EVENT_NAME=merge_group MERGE_GROUP_BASE_SHA="$pr_head"
reject EVENT_NAME=merge_group
reject EVENT_NAME=push
reject EVENT_NAME=pull_request CHECKOUT_REF=refs/heads/ios-pr
reject EVENT_NAME=unexpected

gate() {
  DETECT_RESULT=$1 IOS_NEEDED=$2 BUILD_RESULT=$3 bash "$script_dir/ci-gate.sh"
}
gate success true success
gate success false skipped
for build_result in failure cancelled skipped; do
  if gate success true "$build_result" > "$test_root/rejected.log" 2>&1; then
    echo "Gate accepted required build result $build_result" >&2
    exit 1
  fi
done
for detect_result in failure cancelled skipped; do
  if gate "$detect_result" false skipped > "$test_root/rejected.log" 2>&1; then
    echo "Gate accepted failed detection $detect_result" >&2
    exit 1
  fi
done
if gate success "" skipped > "$test_root/rejected.log" 2>&1; then
  echo "Gate accepted a missing change decision" >&2
  exit 1
fi
echo "iOS CI change detection and gate tests passed."
