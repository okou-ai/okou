#!/usr/bin/env bash
set -euo pipefail

# Run from a full-history dispatched main checkout, before publication. This
# verifies reader compatibility; the first publication also requires the
# recorded API/publisher drain described beside the publication tooling.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"
floor=$(git show origin/main:.github/rollback-floors/registry-archive-reader)
if [[ ! "$floor" =~ ^[0-9a-f]{40}$ ]] || ! git merge-base --is-ancestor "$floor" origin/main; then
  echo "::error::The Registry reader rollback floor must be a full SHA on main." >&2
  exit 1
fi

for origin in https://api.vm0.ai https://api.okou.ai; do
  build=$(curl -fsS --connect-timeout 10 --max-time 30 "${origin}/api/build-info")
  commit=$(jq -er '.commitSha | select(type == "string" and test("^[0-9a-f]{40}$"))' <<<"$build")
  if ! git merge-base --is-ancestor "$floor" "$commit"; then
    echo "::error::${origin} does not serve the independent Registry reader: ${commit}." >&2
    exit 1
  fi
  printf '%s serves the independent Registry reader: %s\n' "$origin" "$commit"
done
