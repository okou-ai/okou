#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "${SCRIPT_DIR}/runner-image-target.sh"

emit() {
  local key=$1 value=$2
  printf '%s=%s\n' "$key" "$value"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT"
  fi
}

: "${HEAD_SHA:?missing required env: HEAD_SHA}"
: "${JOB_REF:?missing required env: JOB_REF}"
: "${METAL_HOSTS:?missing required env: METAL_HOSTS}"
: "${TARGET:?missing required env: TARGET}"
: "${PROFILE:?missing required env: PROFILE}"

runner_image_validate_target "$TARGET"

REPO="${GITHUB_REPOSITORY:-${REPO:-}}"
WORKFLOW="${WORKFLOW:-runner-image.yml}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-1800}"
POLL_SECONDS="${POLL_SECONDS:-30}"
OUTPUT_DIR="${OUTPUT_DIR:-/tmp/runner-image-manifest}"
DEFAULT_ARTIFACT_NAME=$(runner_image_artifact_name "$TARGET" "$HEAD_SHA" "$JOB_REF")
ARTIFACT_NAME="${ARTIFACT_NAME:-$DEFAULT_ARTIFACT_NAME}"
LOOKUP_SHA="${LOOKUP_SHA:-$HEAD_SHA}"

if [ -z "$REPO" ]; then
  echo "missing required env: GITHUB_REPOSITORY or REPO" >&2
  exit 2
fi

if [ "$OUTPUT_DIR" = "/" ]; then
  echo "refusing unsafe OUTPUT_DIR=/" >&2
  exit 2
fi
mkdir -p "$OUTPUT_DIR"

GH_ERR=$(mktemp)
GH_RESPONSE=$(mktemp)
cleanup() {
  rm -f "$GH_ERR" "$GH_RESPONSE"
}
trap cleanup EXIT

deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))

check_deadline() {
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "timed out waiting for runner image workflow ${WORKFLOW} at ${LOOKUP_SHA} with artifact ${ARTIFACT_NAME}" >&2
    exit 1
  fi
}

wait_with_deadline() {
  local seconds=$1
  check_deadline
  if [ "$seconds" -ge "$((deadline - $(date +%s)))" ]; then
    echo "cannot retry within runner image wait deadline: required delay=${seconds}s artifact=${ARTIFACT_NAME}" >&2
    exit 1
  fi
  sleep "$seconds"
}

response_header() {
  awk -v name="$1" '
    /^\r?$/ { exit }
    tolower($1) == name ":" { sub(/\r$/, "", $2); print $2; exit }
  ' "$GH_RESPONSE"
}

api_get() {
  local endpoint=$1 failures=0 backoff=60
  local status retry_after remaining reset delay now
  while true; do
    check_deadline
    if gh api "$endpoint" --include >"$GH_RESPONSE" 2>"$GH_ERR"; then
      sed '1,/^\r\{0,1\}$/d' "$GH_RESPONSE"
      return
    fi
    cat "$GH_ERR" >&2
    status=$(awk 'NR == 1 && /^HTTP\// { print $2 }' "$GH_RESPONSE")
    retry_after=$(response_header retry-after)
    remaining=$(response_header x-ratelimit-remaining)
    reset=$(response_header x-ratelimit-reset)
    if [ "$status" = "429" ] || {
      [ "$status" = "403" ] && {
        [ -n "$retry_after" ] || [ "$remaining" = "0" ] ||
          grep -qi 'rate limit' "$GH_RESPONSE" "$GH_ERR"
      }
    }; then
      # GitHub requires waiting for the declared recovery time. Without usable
      # headers, wait at least a minute and back off instead of spending the
      # ordinary transport-error retry budget on a shared quota cooldown.
      delay=0
      now=$(date +%s)
      if [[ "$retry_after" =~ ^[0-9]+$ ]]; then
        delay=$((10#$retry_after))
      fi
      if [ "$remaining" = "0" ] && [[ "$reset" =~ ^[0-9]+$ ]] &&
        [ "$((10#$reset - now + 1))" -gt "$delay" ]; then
        delay=$((10#$reset - now + 1))
      fi
      if [ "$delay" -le 0 ]; then
        delay=$backoff
      fi
      echo "GitHub API rate limited: status=${status} remaining=${remaining:-unknown} reset=${reset:-unknown}; retrying in ${delay}s" >&2
      wait_with_deadline "$delay"
      backoff=$((backoff * 2))
      if [ "$backoff" -gt 300 ]; then backoff=300; fi
      continue
    fi
    if [[ "$status" == 4* ]]; then
      echo "GitHub API request failed with HTTP ${status}: ${endpoint}" >&2
      exit 1
    fi
    failures=$((failures + 1))
    echo "GitHub API request failed (${failures}/3): ${endpoint}" >&2
    if [ "$failures" -ge 3 ]; then exit 1; fi
    wait_with_deadline "$POLL_SECONDS"
  done
}

selected_run=""
selected_url=""
selected_run_id=""
selected_artifact=""
next_run_check=0
producer_failure_url=""

# Native CI edges guarantee publication before this job is scheduled. Never
# discover another producer, poll, or fall back to a global artifact lookup.
if [ "${RUNNER_IMAGE_RUN_ID+x}" = x ]; then
  if [[ ! "$RUNNER_IMAGE_RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
    [ "$RUNNER_IMAGE_RUN_ID" != "${GITHUB_RUN_ID:-}" ]; then
    echo "runner image producer must be the exact current CI run" >&2
    exit 2
  fi
  selected_run_id="$RUNNER_IMAGE_RUN_ID"
  selected_url="${GITHUB_SERVER_URL:-https://github.com}/${REPO}/actions/runs/${selected_run_id}"
  rm -rf "${OUTPUT_DIR:?}"/*
  gh run download "$selected_run_id" -n "$ARTIFACT_NAME" -D "$OUTPUT_DIR"
else
while true; do
  artifacts_json=$(api_get "repos/${REPO}/actions/artifacts?name=${ARTIFACT_NAME}&per_page=100")

  selected_artifact=$(jq -c \
    --arg name "$ARTIFACT_NAME" \
    '.artifacts
      | map(select(.name == $name and .expired == false))
      | sort_by(.created_at)
      | reverse
      | .[0] // empty' <<<"$artifacts_json")

  if [ -n "$selected_artifact" ]; then
    selected_run_id=$(jq -r '.workflow_run.id' <<<"$selected_artifact")
    echo "runner image artifact found: name=${ARTIFACT_NAME} run_id=${selected_run_id} head_sha=${HEAD_SHA}"
    rm -rf "${OUTPUT_DIR:?}"/*
    download_ok=false
    download_attempts=0
    download_backoff=60
    while [ "$download_attempts" -lt 5 ]; do
      check_deadline
      if gh run download "$selected_run_id" -n "$ARTIFACT_NAME" -D "$OUTPUT_DIR" 2>"$GH_ERR"; then
        download_ok=true
        break
      fi
      cat "$GH_ERR" >&2
      # gh run download does not expose response headers. Use GitHub's
      # conservative headerless cooldown rather than five-second retries.
      if grep -qi 'rate limit\|HTTP 429' "$GH_ERR"; then
        echo "GitHub artifact download rate limited; retrying in ${download_backoff}s" >&2
        wait_with_deadline "$download_backoff"
        download_backoff=$((download_backoff * 2))
        if [ "$download_backoff" -gt 300 ]; then download_backoff=300; fi
        continue
      fi
      if grep -qE 'HTTP (401|403)' "$GH_ERR"; then exit 1; fi
      download_attempts=$((download_attempts + 1))
      echo "artifact ${ARTIFACT_NAME} is listed but not downloadable yet from run ${selected_run_id}; retrying"
      wait_with_deadline 5
    done
    if [ "$download_ok" = "true" ]; then
      break
    fi
    echo "artifact ${ARTIFACT_NAME} could not be downloaded from run ${selected_run_id}; continuing to wait"
  fi

  if [ -n "$producer_failure_url" ]; then
    echo "runner image workflow completed with conclusion=${conclusion}: ${producer_failure_url}" >&2
    exit 1
  fi

  # Artifact readiness is checked more often than producer failure. A direct
  # workflow endpoint also avoids resolving the workflow on every gh run list.
  if [ "$(date +%s)" -ge "$next_run_check" ]; then
    runs_json=$(api_get "repos/${REPO}/actions/workflows/${WORKFLOW}/runs?head_sha=${LOOKUP_SHA}&per_page=20")
    selected_run=$(jq -c '.workflow_runs | sort_by(.created_at) | reverse | .[0] // empty' <<<"$runs_json")
    next_run_check=$(( $(date +%s) + 60 ))
  fi

  if [ -n "$selected_run" ]; then
    status=$(jq -r '.status' <<<"$selected_run")
    conclusion=$(jq -r '.conclusion // empty' <<<"$selected_run")
    run_id=$(jq -r '.id' <<<"$selected_run")
    selected_url=$(jq -r '.html_url' <<<"$selected_run")
    selected_run_id="$run_id"
    echo "waiting for runner image artifact: name=${ARTIFACT_NAME} lookup_sha=${LOOKUP_SHA} producer_run=${run_id} status=${status} conclusion=${conclusion} url=${selected_url}"

    if [ "$status" = "completed" ]; then
      if [ "$conclusion" != "success" ]; then
        # The requested architecture may have uploaded its artifact during a
        # status-request cooldown even if another producer job failed. Recheck
        # artifact readiness once before reporting the producer failure.
        producer_failure_url="$selected_url"
        continue
      fi
    fi
  else
    echo "waiting for runner image artifact ${ARTIFACT_NAME}; no ${WORKFLOW} run found at ${LOOKUP_SHA} yet"
  fi

  wait_with_deadline "$POLL_SECONDS"
done
fi

MANIFEST_PATH="${OUTPUT_DIR}/manifest.json"
if [ ! -f "$MANIFEST_PATH" ]; then
  mapfile -t candidates < <(find "$OUTPUT_DIR" -name manifest.json -type f | sort)
  if [ "${#candidates[@]}" -eq 1 ]; then
    MANIFEST_PATH="${candidates[0]}"
  else
    echo "expected one manifest.json in ${OUTPUT_DIR}, found ${#candidates[@]}" >&2
    exit 1
  fi
fi

MANIFEST_PATH="$MANIFEST_PATH" \
HEAD_SHA="$HEAD_SHA" \
JOB_REF="$JOB_REF" \
TARGET="$TARGET" \
PROFILE="$PROFILE" \
METAL_HOSTS="$METAL_HOSTS" \
SELECTED_HOST="${SELECTED_HOST:-}" \
"$(dirname "$0")/runner-image-manifest.sh" validate

emit "producer-run-id" "$selected_run_id"
emit "producer-run-url" "$selected_url"
