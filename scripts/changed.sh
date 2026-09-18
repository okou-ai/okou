#!/bin/bash
# Check which turbo packages need to be rebuilt by comparing task hashes
# Usage: changed.sh [base-ref]
# Output: JSON object with package names as keys and boolean values (true = changed)
# Example output: {"@okouai/cli": true, "@okouai/web": false}
# Hash-command failures preserve their status; invalid task JSON exits 2.
# Failure diagnostics are bounded/redacted on stderr. Raw dry-run JSON is withheld.

set -euo pipefail

BASE_REF=${1:-HEAD^}
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(git rev-parse --show-toplevel)
TEMP_DIR=$(mktemp -d)
WORKTREE_DIR="$TEMP_DIR/base"

cleanup() {
  local status=$?
  trap - EXIT
  if [ -d "$WORKTREE_DIR" ]; then
    git -C "$REPO_ROOT" worktree remove "$WORKTREE_DIR" --force >/dev/null 2>&1 ||
      echo "Warning: Could not unregister temporary base worktree" >&2
  fi
  rm -rf "$TEMP_DIR" || echo "Warning: Could not remove temporary hash files" >&2
  exit "$status"
}
trap cleanup EXIT

echo "Comparing current HEAD against $BASE_REF..." >&2

# Helper function to extract all task hashes from turbo output
extract_all_hashes() {
  local file=$1
  # Reject incomplete graphs rather than letting consumers interpret them as no changes.
  jq -se '
    if length != 1 then error("Expected one Turbo result") else .[0] end
    | .tasks
    | if type != "array" then error("Expected tasks") else . end
    | if all(.[]; (.task | type == "string") and (.task | length > 0))
      then . else error("Invalid task") end
    | map(select(.task == "build"))
    | if length == 0 then error("No build tasks") else . end
    | if all(.[];
        (.taskId | type == "string") and
        (.taskId | test("^[^#]+#build$")) and
        (.hash | type == "string") and (.hash | length > 0)
      ) then . else error("Invalid build task") end
    | if (map(.taskId) | unique | length) != length
      then error("Duplicate build tasks") else . end
    | map({(.taskId | split("#")[0]): .hash}) | add
  ' "$file" 2>/dev/null
}

report_hash_failure() {
  local phase=$1 commit=$2 status=$3 reason=$4
  local command=${5:-'turbo --skip-infer run build --dry=json'}
  echo "Error: $phase hash calculation for $commit: $reason (exit $status)" >&2
  echo "Command: $command" >&2
  # Never expose dry-run JSON: it may contain resolved environment values.
  # A formatter failure must not replace the original command status.
  node "$SCRIPT_DIR/turbo-hash-diagnostics.mjs" \
    "$TEMP_DIR/$phase.stderr" "$TEMP_DIR/$phase.json" >&2 2>/dev/null ||
    echo "Diagnostic formatting unavailable; captured output withheld" >&2
}

calculate_hashes() {
  local phase=$1 commit=$2 status hashes
  echo "Calculating hashes for $phase commit..." >&2
  if "$TURBO_BIN" --skip-infer run build --dry=json \
    >"$TEMP_DIR/$phase.json" 2>"$TEMP_DIR/$phase.stderr"; then
    :
  else
    status=$?
    report_hash_failure "$phase" "$commit" "$status" "Turbo command failed"
    return "$status"
  fi

  if hashes=$(extract_all_hashes "$TEMP_DIR/$phase.json"); then
    printf '%s\n' "$hashes"
  else
    report_hash_failure "$phase" "$commit" 2 "Invalid or empty Turbo build-task JSON"
    return 2
  fi
}

# Get current commit hash
CURRENT_COMMIT=$(git rev-parse HEAD)
BASE_COMMIT=$(git rev-parse "$BASE_REF")

echo "Current commit: $CURRENT_COMMIT" >&2
echo "Base commit:    $BASE_COMMIT" >&2

# Get task hashes for current commit
cd "$REPO_ROOT/turbo"
# Resolve once, then invoke the same binary with the inherited PATH in both
# worktrees. npx injects cwd-specific PATH entries, which globalEnv hashes.
# Skip version inference so a worktree-local install cannot change the tool.
if TURBO_BIN=$(npx -y turbo@^2.5.6 --skip-infer bin 2>"$TEMP_DIR/current.stderr"); then
  :
else
  status=$?
  printf '%s' "$TURBO_BIN" >"$TEMP_DIR/current.json"
  report_hash_failure current "$CURRENT_COMMIT" "$status" "Turbo executable resolution failed" \
    'npx -y turbo@^2.5.6 --skip-infer bin'
  exit "$status"
fi
CURRENT_HASHES=$(calculate_hashes current "$CURRENT_COMMIT")

# Create a temporary worktree for base commit
echo "Creating worktree for base commit..." >&2
git worktree add --detach "$WORKTREE_DIR" "$BASE_COMMIT" >/dev/null 2>&1

# Get task hashes for base commit
cd "$WORKTREE_DIR/turbo"
BASE_HASHES=$(calculate_hashes base "$BASE_COMMIT")
cd "$REPO_ROOT"

# Compare hashes and generate output
echo "Comparing hashes..." >&2
RESULT=$(jq -n \
  --argjson current "$CURRENT_HASHES" \
  --argjson base "$BASE_HASHES" \
  '$current | to_entries | map({
    key: .key,
    value: (.value != $base[.key])
  }) | from_entries')

echo "Changes detected:" >&2
echo "$RESULT" | jq '.' >&2

# Output the result to stdout (without extra logging)
echo "$RESULT"
