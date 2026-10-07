#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "Usage: $0 <base-commit-sha> <head-commit-sha>" >&2
  exit 1
fi

base_commit="$1"
head_commit="$2"

for commit in "$base_commit" "$head_commit"; do
  if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
    echo "Desktop version comparison requires full lowercase SHA-1 commits: $commit" >&2
    exit 1
  fi
done

read_version() {
  local commit="$1"

  if git cat-file -e "${commit}:desktop/version.txt" 2>/dev/null; then
    git show "${commit}:desktop/version.txt" | tr -d '\n\r'
  else
    # The base commit can still be Electron during the repository migration.
    # Remove after active comparisons and in-flight migration events use native
    # base/head commits; track the drain in okou-ai/okou#37888.
    git show "${commit}:turbo/apps/desktop/package.json" |
      jq -er '.version | select(type == "string" and length > 0)'
  fi
}

base_version="$(read_version "$base_commit")"
head_version="$(read_version "$head_commit")"
changed=false
if [[ "$base_version" != "$head_version" ]]; then
  changed=true
fi

jq -n \
  --argjson changed "$changed" \
  --arg previous_version "$base_version" \
  --arg version "$head_version" \
  '{
    changed: $changed,
    previousVersion: $previous_version,
    version: $version
  }'
