#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_PR_TITLE="$SCRIPT_DIR/../checks/check-pr-title.sh"

expect_pass() {
  local title="$1"
  bash "$CHECK_PR_TITLE" "$title" >/dev/null
}

expect_fail() {
  local title="$1"
  if bash "$CHECK_PR_TITLE" "$title" >/dev/null 2>&1; then
    echo "Expected title to fail: $title" >&2
    exit 1
  fi
}

expect_fail_output_contains() {
  local title="$1"
  local expected="$2"
  local output
  output="$(bash "$CHECK_PR_TITLE" "$title" 2>&1 || true)"
  case "$output" in
    *"$expected"*) ;;
    *)
      echo "Expected failure output for '$title' to contain: $expected" >&2
      echo "Actual output: $output" >&2
      exit 1
      ;;
  esac
}

expect_pass "feat(api): compact chat thread snapshots hourly"
expect_pass "fix: remove stale runner cleanup"
expect_pass "feat(api)!: change runner contract"
expect_pass "revert: remove stale runner cleanup"

expect_fail "Compact chat thread snapshots hourly"
expect_fail "feat(api): Compact chat thread snapshots hourly"
expect_fail "feat(api): compact chat thread snapshots hourly."
expect_fail "feature: compact chat thread snapshots hourly"
expect_fail "fix: "
expect_fail "fix: $(printf 'a%.0s' {1..100})"

expect_fail_output_contains "Compact chat thread snapshots hourly" \
  "Edit the pull request title, then re-run this check"
expect_fail_output_contains "Compact chat thread snapshots hourly" \
  "no new commit is needed"

echo "check-pr-title tests passed"
