#!/bin/bash
# Check if a crate or any of its workspace dependencies have changed.
# Uses cargo metadata to resolve the full internal dependency graph.
#
# Usage: crate-changed.sh <crate-name> <base-ref>
# Exit code: 0 if changed, 1 if not changed, 2 on error
# Example: crate-changed.sh ably-subscriber origin/main

set -eo pipefail

CRATE_NAME=${1:?Usage: crate-changed.sh <crate-name> <base-ref>}
BASE_REF=${2:-HEAD^}

# Get all workspace crates and their internal dependencies
# Must run from crates/ directory where Cargo.toml workspace is defined
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DEPS_JSON=$(cd "$REPO_ROOT/crates" && cargo metadata --no-deps --format-version 1 2>/dev/null | \
  jq '[.packages[] | {name: .name, deps: [.dependencies[] | select(has("path")) | .name]}]') || {
  echo "Error: failed to resolve crate dependencies" >&2
  exit 2
}

# Resolve transitive internal dependencies using BFS
AFFECTED_CRATES=$(echo "$DEPS_JSON" | jq -r --arg crate "$CRATE_NAME" '
  . as $pkgs |
  {queue: [$crate], visited: [$crate]} |
  until(.queue | length == 0;
    .queue[0] as $current |
    ($pkgs | map(select(.name == $current)) | .[0].deps // []) as $deps |
    reduce $deps[] as $dep (.;
      if (.visited | index($dep)) then .
      else .queue += [$dep] | .visited += [$dep]
      end
    ) |
    .queue = .queue[1:]
  ) |
  .visited[]
')

echo "Crate '$CRATE_NAME' depends on: $AFFECTED_CRATES" >&2

# Workspace-level Cargo and tool configuration affects all crates
# Charge removed inputs too, including a pure rename into a different crate.
CHANGED_FILES=$(git -C "$REPO_ROOT" diff --no-renames --name-only "$BASE_REF" HEAD -- crates/)
if echo "$CHANGED_FILES" | grep -qE "^crates/(Cargo\.lock|[^/]+\.toml|\.cargo/.*)$"; then
  echo "Workspace-level file changed, all crates affected" >&2
  exit 0
fi

# Check if any of the affected crate directories have changes
for crate in $AFFECTED_CRATES; do
  if echo "$CHANGED_FILES" | grep -q "^crates/${crate}/"; then
    echo "Changed: crates/${crate}/" >&2
    exit 0
  fi
done

echo "No changes detected for '$CRATE_NAME' or its dependencies" >&2
exit 1
