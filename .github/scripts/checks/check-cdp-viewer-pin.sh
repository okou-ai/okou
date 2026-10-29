#!/usr/bin/env bash
set -euo pipefail

# Usage: bash check-cdp-viewer-pin.sh [repository-root]
# Requires jq, authenticated gh, and GNU timeout. Reads the checked-out manifest
# and queries the public upstream main; no dependency installation is needed.
# Exit 0 only for a full SHA reachable from main; invalid pins/API failures fail.
if (($# > 1)); then
  echo "Usage: $0 [repository-root]" >&2
  exit 2
fi
repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
manifest="${repo_root}/turbo/apps/platform/package.json"
reference=$(jq -er '.dependencies["cdp-viewer"] | select(type == "string")' "$manifest")

if [[ ! "$reference" =~ ^github:okou-ai/cdp-viewer#([0-9a-f]{40})$ ]]; then
  echo "cdp-viewer must pin github:okou-ai/cdp-viewer#<full-40-character-sha>." >&2
  exit 1
fi
sha="${BASH_REMATCH[1]}"

# main is the base, so only an identical or behind head belongs to its history.
# Do not accept an ahead head: a feature branch can contain main without being merged.
status=$(timeout --kill-after=5s 30s gh api \
  "repos/okou-ai/cdp-viewer/compare/main...${sha}" --jq '.status')
case "$status" in
  identical | behind)
    echo "cdp-viewer ${sha} belongs to okou-ai/cdp-viewer main."
    ;;
  *)
    echo "cdp-viewer ${sha} is not verified on upstream main (comparison: ${status})." >&2
    exit 1
    ;;
esac
