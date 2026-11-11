#!/usr/bin/env bash
set -euo pipefail
repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"
case "${EVENT_NAME:?EVENT_NAME is required}" in
  workflow_dispatch) echo true; exit 0 ;;
  pull_request) base=$(bash .github/scripts/checks/changed-base-ref.sh) ;;
  merge_group) base=${MERGE_GROUP_BASE_SHA:?MERGE_GROUP_BASE_SHA is required} ;;
  push) base=${PUSH_BEFORE_SHA:?PUSH_BEFORE_SHA is required} ;;
  *) echo "Unsupported Android CI event: $EVENT_NAME" >&2; exit 2 ;;
esac
base=$(git rev-parse --verify "${base}^{commit}")
git merge-base --is-ancestor "$base" HEAD || {
  echo 'Android CI base is not an ancestor of HEAD' >&2
  exit 2
}
changed_files=$(mktemp)
trap 'rm -f "$changed_files"' EXIT
git diff --no-renames --name-only -z "$base" HEAD > "$changed_files"
needed=false
while IFS= read -r -d '' path; do
  case "$path" in
    android/* | docs/android/* | CLAUDE.md | docs/docs.md | docs/testing.md | .github/workflows/android.yml | .github/scripts/checks/changed-base-ref.sh | .github/scripts/checks/android_launcher.py | .github/scripts/checks/semgrep-results.py | .github/scripts/tests/semgrep-results-test.sh | ios/scripts/sync-design-tokens.py | ios/Okou/Resources/Fonts/* | ios/Assets/AppIcon.svg | turbo/packages/ui/src/styles/globals.css | turbo/packages/api-contracts/src/contracts/* | turbo/packages/api-contracts/src/validators/* | turbo/packages/api-contracts/src/kotlin-bindings/*) needed=true ;;
  esac
done < "$changed_files"
echo "$needed"
