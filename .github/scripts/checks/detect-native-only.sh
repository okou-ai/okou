#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$(git rev-parse --show-toplevel)"

case "${EVENT_NAME:?EVENT_NAME is required}" in
  pull_request)
    base=$(bash "$script_dir/changed-base-ref.sh")
    ;;
  merge_group)
    # Include every entry in the group, not just the last synthetic commit.
    base=${MERGE_GROUP_BASE_SHA:?MERGE_GROUP_BASE_SHA is required}
    ;;
  push)
    # Main builds produce commit-addressed artifacts for release promotion.
    printf 'ios-only=false\nturbo-ts-checks-needed=true\ncodeql-needed=true\n'
    exit 0
    ;;
  *)
    echo "Unsupported native-only detection event: $EVENT_NAME" >&2
    exit 2
    ;;
esac

base=$(git rev-parse --verify "${base}^{commit}")
git merge-base --is-ancestor "$base" HEAD || {
  echo "Native-only CI base is not an ancestor of HEAD" >&2
  exit 2
}

changed_files=$(mktemp)
trap 'rm -f "$changed_files"' EXIT
# A move across the boundary must include both its old and new paths.
git diff --no-renames --name-only -z "$base" HEAD > "$changed_files"
has_changes=false
ios_only=true
crates_only=true
codeql_needed=false
while IFS= read -r -d '' path; do
  has_changes=true
  case "$path" in
    ios/*) crates_only=false ;;
    crates/*) ios_only=false ;;
    *) ios_only=false; crates_only=false ;;
  esac
  # CodeQL scans JavaScript/TypeScript/HTML inputs; skip only when every changed
  # file is non-JS/TS/HTML under native or documentation boundaries.
  case "$path" in
    *.[jJ][sS] | *.[jJ][sS][xX] | *.[mM][jJ][sS] | *.[cC][jJ][sS] | \
    *.[tT][sS] | *.[tT][sS][xX] | *.[mM][tT][sS] | *.[cC][tT][sS] | \
    *.[hH][tT][mM] | *.[hH][tT][mM][lL])
      codeql_needed=true
      ;;
    ios/* | android/* | crates/* | desktop/* | docs/* | *.[mM][dD])
      ;;
    *)
      codeql_needed=true
      ;;
  esac
done < "$changed_files"

if [ "$has_changes" = false ]; then
  ios_only=false
  crates_only=false
  codeql_needed=true
fi
ts_checks_needed=true
if [ "$ios_only" = true ] || [ "$crates_only" = true ]; then
  ts_checks_needed=false
fi
printf 'ios-only=%s\nturbo-ts-checks-needed=%s\ncodeql-needed=%s\n' \
  "$ios_only" "$ts_checks_needed" "$codeql_needed"
