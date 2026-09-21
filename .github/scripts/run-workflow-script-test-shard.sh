#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TESTS_DIR="${WORKFLOW_SCRIPT_TESTS_DIR:-${SCRIPT_DIR}/tests}"
MANIFEST="${WORKFLOW_SCRIPT_TEST_MANIFEST:-${SCRIPT_DIR}/workflow-script-test-shards.txt}"
SHARD_COUNT="${WORKFLOW_SCRIPT_TEST_SHARD_COUNT:-4}"

fail() {
  echo "workflow script shard error: $*" >&2
  exit 1
}

if [[ ! "$SHARD_COUNT" =~ ^[1-9][0-9]*$ ]]; then
  fail "invalid shard count: ${SHARD_COUNT}"
fi
if [[ ! -d "$TESTS_DIR" ]]; then
  fail "tests directory not found: ${TESTS_DIR}"
fi
if [[ ! -f "$MANIFEST" ]]; then
  fail "shard manifest not found: ${MANIFEST}"
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
ACTUAL_TESTS="${WORK_DIR}/actual-tests"
MANIFEST_TESTS="${WORK_DIR}/manifest-tests"
NORMALIZED_MANIFEST="${WORK_DIR}/manifest"

find "$TESTS_DIR" -maxdepth 1 -type f -name '*.sh' -printf '%f\n' |
  LC_ALL=C sort > "$ACTUAL_TESTS"

line_number=0
while read -r shard test_script extra; do
  line_number=$((line_number + 1))
  if [[ -z "${shard:-}" && -z "${test_script:-}" && -z "${extra:-}" ]]; then
    continue
  fi
  if [[ "${shard:-}" == \#* ]]; then
    continue
  fi
  if [[ -n "${extra:-}" ]]; then
    fail "manifest line ${line_number} must contain exactly a shard and test filename"
  fi
  if [[ ! "${shard:-}" =~ ^[1-9][0-9]*$ ]] || ((shard > SHARD_COUNT)); then
    fail "manifest line ${line_number} has invalid shard: ${shard:-<empty>}"
  fi
  if [[ -z "${test_script:-}" || "$test_script" != "${test_script##*/}" || "$test_script" != *-test.sh ]]; then
    fail "manifest line ${line_number} has invalid test filename: ${test_script:-<empty>}"
  fi
  printf '%s %s\n' "$shard" "$test_script" >> "$NORMALIZED_MANIFEST"
  printf '%s\n' "$test_script" >> "$MANIFEST_TESTS"
done < "$MANIFEST"

if [[ ! -s "$NORMALIZED_MANIFEST" ]]; then
  fail "shard manifest is empty"
fi

duplicates="$(LC_ALL=C sort "$MANIFEST_TESTS" | uniq -d)"
if [[ -n "$duplicates" ]]; then
  fail "tests assigned more than once: $(tr '\n' ' ' <<< "$duplicates")"
fi

LC_ALL=C sort -o "$MANIFEST_TESTS" "$MANIFEST_TESTS"
missing="$(comm -23 "$ACTUAL_TESTS" "$MANIFEST_TESTS")"
unknown="$(comm -13 "$ACTUAL_TESTS" "$MANIFEST_TESTS")"
if [[ -n "$missing" ]]; then
  fail "tests missing from manifest: $(tr '\n' ' ' <<< "$missing")"
fi
if [[ -n "$unknown" ]]; then
  fail "unknown tests in manifest: $(tr '\n' ' ' <<< "$unknown")"
fi

for ((shard = 1; shard <= SHARD_COUNT; shard++)); do
  if ! awk -v shard="$shard" '$1 == shard { found = 1 } END { exit !found }' "$NORMALIZED_MANIFEST"; then
    fail "shard ${shard} has no tests"
  fi
done

if [[ "${1:-}" == "--validate-only" ]]; then
  if (($# != 1)); then
    fail "usage: $0 --validate-only | <shard>"
  fi
  echo "workflow script shard manifest: ok"
  exit 0
fi

if (($# != 1)) || [[ ! "$1" =~ ^[1-9][0-9]*$ ]] || (($1 > SHARD_COUNT)); then
  fail "usage: $0 --validate-only | <shard 1-${SHARD_COUNT}>"
fi

requested_shard=$1
shard_started_ns="$(date +%s%N)"
while read -r shard test_script; do
  if ((shard != requested_shard)); then
    continue
  fi

  echo "::group::${test_script}"
  test_started_ns="$(date +%s%N)"
  set +e
  bash "${TESTS_DIR}/${test_script}"
  test_status=$?
  set -e
  test_elapsed_ms=$((( $(date +%s%N) - test_started_ns ) / 1000000))
  echo "::notice title=Workflow script timing::${test_script}: ${test_elapsed_ms} ms"
  echo "::endgroup::"

  if ((test_status != 0)); then
    exit "$test_status"
  fi
done < "$NORMALIZED_MANIFEST"

shard_elapsed_ms=$((( $(date +%s%N) - shard_started_ns ) / 1000000))
echo "Workflow script shard ${requested_shard}/${SHARD_COUNT}: ${shard_elapsed_ms} ms"
