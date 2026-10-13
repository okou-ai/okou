#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="${SCRIPT_DIR}/run-workflow-script-test-shard.sh"
TEST_ROOT="$(mktemp -d)"
TESTS_DIR="${TEST_ROOT}/tests"
MANIFEST="${TEST_ROOT}/manifest"
EXECUTION_LOG="${TEST_ROOT}/execution.log"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

mkdir -p "$TESTS_DIR"
cat > "${TESTS_DIR}/alpha-test.sh" <<'SCRIPT'
#!/usr/bin/env bash
printf 'alpha\n' >> "$EXECUTION_LOG"
SCRIPT
cat > "${TESTS_DIR}/beta-test.sh" <<'SCRIPT'
#!/usr/bin/env bash
printf 'beta\n' >> "$EXECUTION_LOG"
SCRIPT

run_runner() {
  WORKFLOW_SCRIPT_TESTS_DIR="$TESTS_DIR" \
    WORKFLOW_SCRIPT_TEST_MANIFEST="$MANIFEST" \
    WORKFLOW_SCRIPT_TEST_SHARD_COUNT=2 \
    EXECUTION_LOG="$EXECUTION_LOG" \
    "$RUNNER" "$@"
}

expect_failure() {
  local expected=$1
  shift
  local output
  if output="$(run_runner "$@" 2>&1)"; then
    fail "expected shard runner to fail"
  fi
  if [[ "$output" != *"$expected"* ]]; then
    fail "expected failure containing '${expected}', got: ${output}"
  fi
}

cat > "$MANIFEST" <<'MANIFEST'
1 alpha-test.sh
2 beta-test.sh
MANIFEST
run_runner --validate-only >/dev/null

: > "$EXECUTION_LOG"
run_runner 1 >/dev/null
run_runner 2 >/dev/null
if [[ "$(LC_ALL=C sort "$EXECUTION_LOG")" != $'alpha\nbeta' ]]; then
  fail "valid shards must execute every test exactly once"
fi

cat > "$MANIFEST" <<'MANIFEST'
1 alpha-test.sh
2 alpha-test.sh
MANIFEST
expect_failure "tests assigned more than once" --validate-only

cat > "$MANIFEST" <<'MANIFEST'
1 alpha-test.sh
2 gamma-test.sh
MANIFEST
expect_failure "tests missing from manifest: beta-test.sh" --validate-only

cat > "$MANIFEST" <<'MANIFEST'
1 alpha-test.sh
2 beta-test.sh
2 gamma-test.sh
MANIFEST
expect_failure "unknown tests in manifest: gamma-test.sh" --validate-only

cat > "$MANIFEST" <<'MANIFEST'
1 alpha-test.sh
3 beta-test.sh
MANIFEST
expect_failure "invalid shard: 3" --validate-only

cat > "$MANIFEST" <<'MANIFEST'
1 alpha-test.sh
1 beta-test.sh
MANIFEST
expect_failure "shard 2 has no tests" --validate-only

cat > "${TESTS_DIR}/beta-test.sh" <<'SCRIPT'
#!/usr/bin/env bash
exit 23
SCRIPT
cat > "$MANIFEST" <<'MANIFEST'
1 alpha-test.sh
2 beta-test.sh
MANIFEST
status=0
run_runner 2 >/dev/null 2>&1 || status=$?
if [[ "$status" -ne 23 ]]; then
  fail "test failure status must propagate, got ${status}"
fi

# Exercise default discovery across real owner-relative paths in an isolated
# checkout layout, including execution from an unrelated working directory.
repo="$TEST_ROOT/repository"
ci="$repo/.github/scripts"
native="crates/runner/tests/behavior/tests/owned-test.sh"
mkdir -p "$ci/tests" "$repo/crates/runner/tests/behavior/tests" \
  "$repo/crates/sandbox-firecracker/tests/native/tests" \
  "$repo/crates/nbd-cow/tests/infrastructure" \
  "$repo/crates/kerberos-worker/tests/infrastructure"
cp "$RUNNER" "$ci/run-workflow-script-test-shard.sh"
cp "$TESTS_DIR/alpha-test.sh" "$ci/tests/alpha-test.sh"
cat > "$repo/$native" <<'SCRIPT'
#!/usr/bin/env bash
printf 'native\n' >> "$EXECUTION_LOG"
exit "${NATIVE_STATUS:-0}"
SCRIPT
printf '1 alpha-test.sh\n2 %s\n' "$native" > "$ci/workflow-script-test-shards.txt"
run_owned() {
  (
    cd "$TEST_ROOT"
    unset WORKFLOW_SCRIPT_TESTS_DIR WORKFLOW_SCRIPT_TEST_MANIFEST
    WORKFLOW_SCRIPT_TEST_SHARD_COUNT=2 EXECUTION_LOG="$EXECUTION_LOG" \
      bash "$ci/run-workflow-script-test-shard.sh" "$@"
  )
}
: > "$EXECUTION_LOG"
run_owned --validate-only >/dev/null
run_owned 1 >/dev/null
run_owned 2 >/dev/null
[[ "$(LC_ALL=C sort "$EXECUTION_LOG")" == $'alpha\nnative' ]] \
  || fail "owner-relative shards must execute every suite exactly once"
status=0
NATIVE_STATUS=37 run_owned 2 >/dev/null 2>&1 || status=$?
[[ "$status" -eq 37 ]] || fail "native failure status must propagate, got $status"

for invalid in "${native%/*}/../owned-test.sh" \
  "${native%/*}/nested/owned-test.sh" "/$native"; do
  printf '1 alpha-test.sh\n2 %s\n' "$invalid" > "$ci/workflow-script-test-shards.txt"
  if run_owned --validate-only >/dev/null 2>&1; then
    fail "invalid native path accepted: $invalid"
  fi
done
printf '1 alpha-test.sh\n2 %s\n' "$native" > "$ci/workflow-script-test-shards.txt"
printf '#!/usr/bin/env bash\nexit 0\n' > "${repo}/${native%/*}/unregistered-test.sh"
if run_owned --validate-only >/dev/null 2>&1; then
  fail "unregistered native suite was omitted"
fi
rm "${repo}/${native%/*}/unregistered-test.sh" "$repo/$native"
if run_owned --validate-only >/dev/null 2>&1; then
  fail "missing native suite was accepted"
fi

echo "workflow-script-test-shards-test: ok"
