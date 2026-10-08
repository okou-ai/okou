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

  git show "${commit}:desktop/version.txt" | tr -d '\n\r'
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
