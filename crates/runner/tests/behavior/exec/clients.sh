#!/usr/bin/env bash
set -euo pipefail

BIN_DIR=$1
SANDBOX_ID=$2
fail() { echo "FAIL: $1"; exit 1; }

SCENARIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Test 8: verify the installed Claude accepts and appends to a native compact
# generation without changing its session ID. The loopback terminator prevents
# any external model request.
echo "--- Test: Claude compact-generation compatibility ---"
sudo "$BIN_DIR/runner" exec --timeout 75 \
  --sandbox "$SANDBOX_ID" -- python3 -c "$(<"$SCENARIO_DIR/claude-compact.py")" \
  || fail "Claude compact-generation compatibility"
echo "PASS: Claude compact-generation compatibility"

# Test 9: verify successful usage notifications and that the bundled Codex
# resumes and appends a native compact generation under the same thread ID.
echo "--- Test: Codex compact-generation compatibility ---"
sudo "$BIN_DIR/runner" exec --timeout 75 \
  --sandbox "$SANDBOX_ID" -- python3 -c "$(<"$SCENARIO_DIR/codex-compact.py")" \
  || fail "Codex compact-generation compatibility"
echo "PASS: Codex compact-generation compatibility"
