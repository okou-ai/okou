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
  local endpoint=$1 failures=0 backoff=60 allow_not_found=false
  local status retry_after remaining reset delay now
  shift
  if [ "${1:-}" = "--allow-not-found" ]; then allow_not_found=true; shift; fi
  while true; do
    check_deadline
    if gh api "$endpoint" --include "$@" >"$GH_RESPONSE" 2>"$GH_ERR"; then
      sed '1,/^\r\{0,1\}$/d' "$GH_RESPONSE"
      return
    fi
    status=$(awk 'NR == 1 && /^HTTP\// { print $2 }' "$GH_RESPONSE")
    if $allow_not_found && [ "$status" = "404" ]; then return 44; fi
    cat "$GH_ERR" >&2
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

consumer_identity_matches() {
  jq -e --arg repo "$REPO" --arg sha "$LOOKUP_SHA" \
    --arg event "$GITHUB_EVENT_NAME" --arg branch "$consumer_branch" \
    --argjson id "$GITHUB_RUN_ID" --argjson attempt "$GITHUB_RUN_ATTEMPT" '
    .id == $id and .run_attempt == $attempt and .head_sha == $sha and
    .repository.full_name == $repo and .head_repository.full_name == $repo and
    .event == $event and .head_branch == $branch and
    (.path == ".github/workflows/turbo.yml" or .path == ".github/workflows/crates.yml") and
    (.status == "queued" or .status == "in_progress" or .status == "pending" or
     .status == "waiting" or .status == "requested" or .status == "completed")
  ' <<<"$1" >/dev/null
}

consumer_obsolete_state() {
  local ref_json ref_status pr_json query
  if [ "$GITHUB_EVENT_NAME" = "merge_group" ]; then
    if ref_json=$(api_get "repos/${REPO}/git/ref/${GITHUB_REF#refs/}" --allow-not-found); then
      if ! jq -e --arg ref "$GITHUB_REF" '
        .ref == $ref and .object.type == "commit" and
        (.object.sha | type == "string" and test("^[0-9a-f]{40}$"))
      ' <<<"$ref_json" >/dev/null; then
        echo "invalid merge-group ref response" >&2
        return 1
      fi
      jq -r --arg sha "$GITHUB_SHA" '.object.sha != $sha' <<<"$ref_json"
    else
      ref_status=$?
      [ "$ref_status" = "44" ] || return "$ref_status"
      echo true
    fi
  else
    query="query(\$owner:String!,\$name:String!,\$number:Int!) { repository(owner:\$owner,name:\$name) { pullRequest(number:\$number) { state headRefOid isInMergeQueue headRepository { nameWithOwner } } } }"
    pr_json=$(api_get graphql -f query="$query" -f owner="${REPO%%/*}" \
      -f name="${REPO#*/}" -F number="$pr_number") || return 1
    if ! jq -e --arg repo "$REPO" '
      ((.errors // []) | length == 0) and
      (.data.repository.pullRequest |
        (.state == "OPEN" or .state == "CLOSED" or .state == "MERGED") and
        (.headRefOid | type == "string" and test("^[0-9a-f]{40}$")) and
        (.isInMergeQueue | type == "boolean") and
        (.state != "OPEN" or .headRepository.nameWithOwner == $repo))
    ' <<<"$pr_json" >/dev/null; then
      echo "invalid current PR ownership response" >&2
      return 1
    fi
    jq -r --arg sha "$LOOKUP_SHA" '.data.repository.pullRequest |
      .state != "OPEN" or .headRefOid != $sha or .isInMergeQueue == true
    ' <<<"$pr_json"
  fi
}

cancel_obsolete_consumer() {
  # GitHub owns PR/ref lifecycle. Keep this guard while independent producer
  # cancellation can leave a consumer outside the selected-owner barrier.
  [ "${CHECK_OBSOLETE_CONSUMER:-false}" = "true" ] || return 0
  case "${GITHUB_EVENT_NAME:-}" in
    merge_group|pull_request) ;;
    *) return 0 ;;
  esac
  local run_json pr_number obsolete
  local consumer_branch cancel_status cancel_deadline cancel_wait_seconds cancel_remaining
  if [[ ! "${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]*$ ||
    ! "${GITHUB_RUN_ATTEMPT:-}" =~ ^[1-9][0-9]*$ ||
    "$HEAD_SHA" != "${GITHUB_SHA:-}" || ! "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ||
    ! "$LOOKUP_SHA" =~ ^[0-9a-f]{40}$ || ! "$JOB_REF" =~ ^pr-([1-9][0-9]*)$ ]]; then
    echo "invalid native runner consumer cancellation context" >&2
    return 1
  fi
  pr_number=${JOB_REF#pr-}
  if [ "$GITHUB_EVENT_NAME" = "merge_group" ]; then
    consumer_branch=${GITHUB_REF#refs/heads/}
    if [[ "$GITHUB_REF" != refs/heads/gh-readonly-queue/* ||
      ! "$consumer_branch" =~ /pr-${pr_number}-[0-9a-f]{40}$ ]]; then
      echo "runner consumer ref does not identify $JOB_REF" >&2
      return 1
    fi
  else
    consumer_branch=${GITHUB_HEAD_REF:?missing native PR head ref}
    if [ "${GITHUB_REF:-}" != "refs/pull/${pr_number}/merge" ]; then
      echo "runner consumer ref does not identify $JOB_REF" >&2
      return 1
    fi
  fi
  run_json=$(api_get "repos/${REPO}/actions/runs/${GITHUB_RUN_ID}")
  if ! consumer_identity_matches "$run_json"; then
    echo "runner consumer run or attempt no longer matches native context" >&2
    return 1
  fi

  obsolete=$(consumer_obsolete_state) || return 1
  [ "$obsolete" = "true" ] || return 0

  # Recheck authority as well as identity: a ref/head can be restored, and a
  # rerun retains its run ID. Never cancel from stale obsolescence evidence.
  obsolete=$(consumer_obsolete_state) || return 1
  [ "$obsolete" = "true" ] || return 0
  run_json=$(api_get "repos/${REPO}/actions/runs/${GITHUB_RUN_ID}")
  if ! consumer_identity_matches "$run_json"; then
    echo "obsolete consumer attempt changed before cancellation" >&2
    return 1
  fi
  cancel_wait_seconds=${CONSUMER_CANCEL_WAIT_SECONDS:-360}
  if [[ ! "$cancel_wait_seconds" =~ ^[1-9][0-9]{0,2}$ ]] || ((cancel_wait_seconds > 360)); then
    echo "invalid consumer cancellation wait budget" >&2
    return 1
  fi
  if ! jq -e '.status == "completed" and .conclusion == "cancelled"' <<<"$run_json" >/dev/null; then
    if gh api --method POST "repos/${REPO}/actions/runs/${GITHUB_RUN_ID}/force-cancel" \
      --include >"$GH_RESPONSE" 2>"$GH_ERR"; then
      cancel_status=$(awk 'NR == 1 && /^HTTP\// { print $2 }' "$GH_RESPONSE")
      if [ "$cancel_status" != "202" ]; then
        echo "unexpected consumer cancellation response: ${cancel_status}" >&2
        return 1
      fi
    else
      cancel_status=$(awk 'NR == 1 && /^HTTP\// { print $2 }' "$GH_RESPONSE")
      if [ "$cancel_status" != "409" ]; then
        cat "$GH_ERR" >&2
        echo "failed to request native obsolete-consumer cancellation" >&2
        return 1
      fi
      run_json=$(api_get "repos/${REPO}/actions/runs/${GITHUB_RUN_ID}")
      if ! consumer_identity_matches "$run_json" ||
        ! jq -e '.status == "completed" and .conclusion == "cancelled"' <<<"$run_json" >/dev/null; then
        echo "obsolete-consumer cancellation conflict without terminal cancellation proof" >&2
        return 1
      fi
    fi
  fi
  echo "Requested cancellation of obsolete consumer ${GITHUB_RUN_ID}; waiting for Actions interruption" >&2
  cancel_deadline=$(( $(date +%s) + cancel_wait_seconds ))
  while [ "$(date +%s)" -lt "$cancel_deadline" ]; do
    # Once cancellation is accepted, the artifact deadline must not manufacture
    # a failure while Actions is still delivering its interruption.
    cancel_remaining=$(( cancel_deadline - $(date +%s) ))
    if [ "$cancel_remaining" -gt 5 ]; then cancel_remaining=5; fi
    if [ "$cancel_remaining" -gt 0 ]; then sleep "$cancel_remaining"; fi
  done
  echo "Actions did not interrupt obsolete consumer ${GITHUB_RUN_ID} within ${cancel_wait_seconds}s" >&2
  return 1
}

selected_run=""
selected_url=""
selected_run_id=""
selected_artifact=""
next_run_check=0
producer_failure_url=""
next_consumer_check=0

while true; do
  if [ "$(date +%s)" -ge "$next_consumer_check" ]; then
    cancel_obsolete_consumer
    next_consumer_check=$(( $(date +%s) + 60 ))
  fi
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
    cancel_obsolete_consumer
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

cancel_obsolete_consumer

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
