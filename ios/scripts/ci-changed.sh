#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

case "${EVENT_NAME:?EVENT_NAME is required}" in
  workflow_dispatch)
    printf 'needed=true\nscripts-needed=true\n'
    exit 0
    ;;
  pull_request)
    base=$(bash .github/scripts/checks/changed-base-ref.sh)
    ;;
  merge_group)
    # The event base covers every entry in the group, not only HEAD's last parent.
    base=${MERGE_GROUP_BASE_SHA:?MERGE_GROUP_BASE_SHA is required}
    ;;
  push)
    # A push may contain multiple commits; HEAD^ can miss an earlier iOS change.
    base=${PUSH_BEFORE_SHA:?PUSH_BEFORE_SHA is required}
    ;;
  *)
    echo "Unsupported iOS CI event: $EVENT_NAME" >&2
    exit 2
    ;;
esac

base=$(git rev-parse --verify "${base}^{commit}")
git merge-base --is-ancestor "$base" HEAD || {
  echo "iOS CI base is not an ancestor of HEAD" >&2
  exit 2
}

changed_files=$(mktemp)
trap 'rm -f "$changed_files"' EXIT
# Disable rename folding so moves both into and out of ios/ select the check.
git diff --no-renames --name-only -z "$base" HEAD > "$changed_files"
needed=false
scripts_needed=false
while IFS= read -r -d '' changed_file; do
  case "$changed_file" in
    ios/scripts/* | ios/*.entitlements | .github/workflows/ios.yml | .github/workflows/ios-build-cache.yml | \
      .github/actions/setup-ios-build-cache/* | .github/workflows/ios-archive-proof.yml | \
      .github/workflows/release-please.yml | .github/scripts/checks/changed-base-ref.sh | release-please-config.json)
      needed=true
      scripts_needed=true
      ;;
    ios/*) needed=true ;;
  esac
done < "$changed_files"
# Native validation of a release head belongs to the merge group. A change
# to the CI scripts themselves must still run their tests on the PR.
if [[ "$EVENT_NAME" == pull_request && "${HEAD_REF:-}" == release-please--branches--* ]]; then
  needed=false
fi
printf 'needed=%s\nscripts-needed=%s\n' "$needed" "$scripts_needed"
