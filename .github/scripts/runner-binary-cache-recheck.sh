#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="${SCRIPT_DIR}/runner-binary-cache.sh"

fail() {
  echo "::error::Runner binary cache recheck: $*" >&2
  exit 1
}
emit() {
  printf '%s=%s\n' "$1" "$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
  fi
}
for name in REPO CURRENT_RUN_ID EXPECTED_TARGET EXPECTED_BINARY_INPUT_DIGEST OUTPUT_DIR; do
  [ -n "${!name:-}" ] || fail "missing required env: ${name}"
done
[[ "$REPO" =~ ^[A-Za-z0-9_-][A-Za-z0-9_.-]*/[A-Za-z0-9_-][A-Za-z0-9_.-]*$ ]] || fail "invalid repository"
[[ "$CURRENT_RUN_ID" =~ ^[1-9][0-9]*$ ]] || fail "invalid run ID"
if [ "$OUTPUT_DIR" = / ] || [ -e "$OUTPUT_DIR" ] || [ -L "$OUTPUT_DIR" ]; then
  fail "output directory already exists or is unsafe"
fi
mkdir -p "$(dirname "$OUTPUT_DIR")"
work=$(mktemp -d "$(dirname "$OUTPUT_DIR")/runner-binary-recheck.XXXXXX")
lookup_pid='' required_pid=''
trap 'rm -rf "$work"' EXIT
cancel() {
  trap '' INT TERM HUP
  if [ -n "$lookup_pid" ]; then
    kill -KILL -- "-$lookup_pid" 2>/dev/null || kill -KILL "$lookup_pid" 2>/dev/null || true
    wait "$lookup_pid" 2>/dev/null || true
  fi
  if [ -n "$required_pid" ]; then
    # The required download owns its GET process group and cancellation cleanup.
    kill -TERM "$required_pid" 2>/dev/null || true
    wait "$required_pid" 2>/dev/null || true
  fi
  exit "$1"
}
trap 'cancel 130' INT
trap 'cancel 143' TERM
trap 'cancel 129' HUP
run_required() {
  local required_status=0
  "$@" &
  required_pid=$!
  wait "$required_pid" || required_status=$?
  required_pid=
  return "$required_status"
}

# This is one optional lookup, not an in-flight producer wait. Keep its budget
# below a normal compilation phase and keep malformed/cancelled success fatal.
started=$(date +%s)
status=0
timeout --kill-after=5s 15s env GITHUB_OUTPUT= RUNNER_TEMP="$work" \
  RESOLVE_OUTPUT_DIR="${work}/lookup" "$CACHE" resolve-reference \
  >"${work}/lookup.out" 2>"${work}/lookup.err" &
lookup_pid=$!
wait "$lookup_pid" || status=$?
lookup_pid=
emit lookup-duration-seconds "$(( $(date +%s) - started ))"
if [ "$status" = 124 ] || [ "$status" = 137 ]; then
  emit reused false
  emit resolve-reason resolve-timeout
  exit 0
elif [ "$status" != 0 ]; then
  fail "reference lookup failed (exit ${status})"
fi
field() { awk -F= -v key="$1" '$1 == key { print substr($0, index($0, "=") + 1) }' "${work}/lookup.out"; }
reason=$(field resolve-reason)
[[ "$reason" =~ ^[a-z][a-z0-9-]*$ ]] || fail "invalid lookup reason"
case "$(field resolve-outcome)" in
  miss)
    emit reused false
    emit resolve-reason "$reason"
    ;;
  hit)
    index_run_id=$(field resolve-producer-run-id)
    [[ "$index_run_id" =~ ^[1-9][0-9]*$ ]] || fail "invalid cache index run ID"
    reference=$(jq -c . "${work}/lookup/reference.json")
    run_required env GITHUB_OUTPUT= RUNNER_TEMP="$work" CACHE_REFERENCE="$reference" RESOLVE_OUTPUT_DIR="${work}/bytes" \
      "$CACHE" download-reference >/dev/null
    run_required env GITHUB_OUTPUT= FRESH_METADATA_PATH="${work}/bytes/metadata.json" \
      RUNNER_PATH="${work}/bytes/runner" "$CACHE" fresh-validate >/dev/null
    # The index run is lineage, not authenticated compilation provenance. Do
    # not turn a cached object into a freshly compiled current-run producer.
    jq --arg repo "$REPO" --argjson run "$CURRENT_RUN_ID" \
      --argjson index "$index_run_id" --argjson reference "$reference" '{
        schemaVersion: 1, kind: "cached", repository: $repo, runId: $run,
        cacheIndexRunId: $index, reference: $reference, metadata: .
      }' "${work}/bytes/metadata.json" > "${work}/bytes/cached-reference.json"
    mv "${work}/bytes" "$OUTPUT_DIR"
    emit reused true
    emit resolve-reason "$reason"
    emit cache-index-run-id "$index_run_id"
    ;;
  *) fail "invalid lookup outcome" ;;
esac
