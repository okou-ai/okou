#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "${SCRIPT_DIR}/runner-image-target.sh"

CACHE="${SCRIPT_DIR}/runner-binary-cache.sh"
DIGEST="${SCRIPT_DIR}/runner-binary-build/digest.sh"
RUNNER_BINARY_RESOLVE_TIMEOUT_SECONDS=60
RUNNER_BINARY_RESOLVE_KILL_AFTER_SECONDS=5

emit() {
  local key=$1 value=$2
  printf '%s=%s\n' "$key" "$value"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT"
  fi
}

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 2
  fi
}

output_value() {
  local key=$1 file=$2
  sed -n "s/^${key}=//p" "$file" | tail -n1
}

require_env RUNNER_HOST_GROUPS_MATRIX
require_env RESOLVE_OUTPUT_DIR

case "${RUNNER_BINARY_CACHE_FORCE_MISS:-false}" in
  true|false|"") ;;
  *)
    echo "invalid RUNNER_BINARY_CACHE_FORCE_MISS: ${RUNNER_BINARY_CACHE_FORCE_MISS}" >&2
    exit 2
    ;;
esac

if [ "$RESOLVE_OUTPUT_DIR" = "/" ] || [ -e "$RESOLVE_OUTPUT_DIR" ] || [ -L "$RESOLVE_OUTPUT_DIR" ]; then
  echo "runner binary plan output already exists or is unsafe: ${RESOLVE_OUTPUT_DIR}" >&2
  exit 2
fi
if ! jq -e '
  type == "array" and length > 0 and
  all(.[];
    type == "object" and
    (keys | sort) == ["assetSuffix", "cacheSuffix", "id", "label", "target", "unameM"] and
    (.id | type == "string" and length > 0) and
    (.label | type == "string" and length > 0) and
    (.target | type == "string" and length > 0) and
    (.unameM | type == "string" and length > 0) and
    (.cacheSuffix | type == "string" and length > 0) and
    (.assetSuffix | type == "string" and length > 0)
  ) and
  ((map(.id) | unique | length) == length) and
  ((map(.target) | unique | length) == length)
' <<<"$RUNNER_HOST_GROUPS_MATRIX" >/dev/null; then
  echo "invalid runner host groups matrix" >&2
  exit 2
fi

mkdir -p "$RESOLVE_OUTPUT_DIR"
temp_parent="${RUNNER_TEMP:-$(dirname "$RESOLVE_OUTPUT_DIR")}"
mkdir -p "$temp_parent"
temp_root=$(mktemp -d "${temp_parent}/runner-binary-plan.XXXXXX")
PLAN_TEMP_ROOT="$temp_root"
trap 'rm -rf "$PLAN_TEMP_ROOT"' EXIT

declare -a targets=() entries=() digests=() pids=() starts=()
while IFS= read -r encoded_entry; do
  entry=$(base64 -d <<<"$encoded_entry")
  target=$(jq -r '.target' <<<"$entry")
  runner_image_validate_target "$target"
  digest_output=$(env GITHUB_OUTPUT= "$DIGEST" "$target")
  digest=$(sed -n 's/^binary-input-digest=//p' <<<"$digest_output" | tail -n1)
  if [[ ! "$digest" =~ ^[0-9a-f]{64}$ ]]; then
    echo "runner binary digest command returned an invalid digest for ${target}" >&2
    exit 2
  fi

  index=${#targets[@]}
  targets+=("$target")
  entries+=("$entry")
  digests+=("$digest")
  starts+=("$(date +%s)")
  result_file="${temp_root}/${index}.out"
  error_file="${temp_root}/${index}.err"
  timeout --kill-after="${RUNNER_BINARY_RESOLVE_KILL_AFTER_SECONDS}s" \
    "${RUNNER_BINARY_RESOLVE_TIMEOUT_SECONDS}s" \
    env GITHUB_OUTPUT= \
      EXPECTED_TARGET="$target" \
      EXPECTED_BINARY_INPUT_DIGEST="$digest" \
      RESOLVE_OUTPUT_DIR="${RESOLVE_OUTPUT_DIR}/${target}" \
      "$CACHE" resolve-reference \
      >"$result_file" 2>"$error_file" &
  pids+=("$!")
done < <(jq -cr '.[] | @base64' <<<"$RUNNER_HOST_GROUPS_MATRIX")

miss_matrix='[]'
hit_targets='[]'
hit_references='{}'
resolution_json='[]'
hit_count=0
miss_count=0
hard_failure=false

for index in "${!targets[@]}"; do
  target=${targets[$index]}
  entry=${entries[$index]}
  digest=${digests[$index]}
  result_file="${temp_root}/${index}.out"
  error_file="${temp_root}/${index}.err"
  status=0
  wait "${pids[$index]}" || status=$?
  duration=$(($(date +%s) - starts[index]))

  if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
    rm -rf "${RESOLVE_OUTPUT_DIR:?}/${target}"
    outcome=miss
    source=""
    reason=resolve-timeout
    producer_run_id=""
    candidate_inspections=0
  elif [ "$status" -ne 0 ]; then
    echo "runner binary resolution failed for ${target}" >&2
    sed 's/^/  /' "$error_file" >&2
    hard_failure=true
    continue
  else
    outcome=$(output_value resolve-outcome "$result_file")
    source=$(output_value resolve-source "$result_file")
    reason=$(output_value resolve-reason "$result_file")
    producer_run_id=$(output_value resolve-producer-run-id "$result_file")
    candidate_inspections=$(output_value candidate-inspections "$result_file")
    candidate_inspections=${candidate_inspections:-0}
    if [ "$outcome" != "hit" ] && [ "$outcome" != "miss" ]; then
      echo "runner binary resolution returned an invalid outcome for ${target}: ${outcome}" >&2
      hard_failure=true
      continue
    fi
  fi

  if [ "$outcome" = "hit" ]; then
    if [ ! -f "${RESOLVE_OUTPUT_DIR}/${target}/reference.json" ]; then
      echo "runner binary cache reference is missing for ${target}" >&2
      hard_failure=true
      continue
    fi
    hit_targets=$(jq -c --arg target "$target" '. + [$target]' <<<"$hit_targets")
    hit_references=$(jq -c --arg target "$target" \
      --slurpfile reference "${RESOLVE_OUTPUT_DIR}/${target}/reference.json" \
      '. + {($target): $reference[0]}' <<<"$hit_references")
    hit_count=$((hit_count + 1))
  else
    miss_matrix=$(jq -c --argjson entry "$entry" '. + [$entry]' <<<"$miss_matrix")
    miss_count=$((miss_count + 1))
  fi
  resolution_json=$(jq -c \
    --arg target "$target" \
    --arg digest "$digest" \
    --arg outcome "$outcome" \
    --arg source "$source" \
    --arg reason "$reason" \
    --arg producer_run_id "$producer_run_id" \
    --argjson duration "$duration" \
    --argjson candidate_inspections "$candidate_inspections" '
      . + [{
        target: $target,
        binaryInputDigest: $digest,
        outcome: $outcome,
        source: $source,
        reason: $reason,
        producerRunId: $producer_run_id,
        durationSeconds: $duration,
        candidateInspections: $candidate_inspections
      }]
    ' <<<"$resolution_json")
done

if [ "$hard_failure" = "true" ]; then
  exit 1
fi
if [ $((hit_count + miss_count)) -ne "${#targets[@]}" ]; then
  echo "runner binary plan did not classify every target" >&2
  exit 1
fi

emit "compile-matrix" "$miss_matrix"
emit "hit-targets" "$hit_targets"
emit "hit-references" "$hit_references"
emit "hit-count" "$hit_count"
emit "miss-count" "$miss_count"
printf 'resolution-json=%s\n' "$resolution_json"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Runner binary cache plan"
    echo
    echo "| Target | Outcome | Source | Reason | Index run | Candidates | Duration |"
    echo "| --- | --- | --- | --- | --- | ---: | ---: |"
    jq -r '.[] | "| `\(.target)` | `\(.outcome)` | `\(.source // "")` | `\(.reason)` | `\(.producerRunId // "")` | \(.candidateInspections) | \(.durationSeconds)s |"' \
      <<<"$resolution_json"
  } >> "$GITHUB_STEP_SUMMARY"
fi
