#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "${SCRIPT_DIR}/runner-image-target.sh"

usage() {
  cat <<'USAGE'
Usage: runner-image-context.sh <resolve|turbo-consumer|playwright-consumer|crates-consumer|image-inputs|needed|artifact-name>

resolve:
  Computes release skip, canonical job ref, and head SHA from GitHub event env.

needed:
  Computes runner image consumer demand and current-image selection from
  explicit workflow selection booleans.

turbo-consumer:
  Computes whether Turbo runner E2E is a runner image consumer from the same
  change booleans used by turbo.yml.

playwright-consumer:
  Computes whether Playwright needs a dedicated runner.

crates-consumer:
  Computes whether Crates runner tests are a runner image consumer from the
  same change booleans used by crates.yml runner-test-prepare.

image-inputs:
  Computes whether current commit inputs can change the produced runner image.

artifact-name:
  Computes the GitHub artifact name for a runner image manifest.
USAGE
}

bool() {
  case "${1:-false}" in
    true|True|TRUE|1|yes|YES) echo "true" ;;
    *) echo "false" ;;
  esac
}

is_true() {
  [ "$(bool "${1:-false}")" = "true" ]
}

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

env_value() {
  local name=$1
  printf '%s\n' "${!name}"
}

pr_branch() {
  local pr_number=$1
  if [ -n "${MOCK_PR_BRANCH:-}" ]; then
    printf '%s\n' "$MOCK_PR_BRANCH"
    return 0
  fi
  require_env REPO
  require_env GH_TOKEN
  gh pr view "$pr_number" --repo "$REPO" --json headRefName --jq .headRefName 2>/dev/null || true
}

pr_state() {
  local pr_number=$1
  if [ -n "${MOCK_PR_STATE:-}" ]; then
    printf '%s\n' "$MOCK_PR_STATE"
    return 0
  fi
  require_env REPO
  require_env GH_TOKEN
  curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    "https://api.github.com/repos/${REPO}/pulls/${pr_number}" \
    | jq -r .state
}

resolve() {
  require_env EVENT_NAME
  local head_sha="${HEAD_SHA:-${GITHUB_SHA:-}}"
  if [ -z "$head_sha" ]; then
    echo "missing HEAD_SHA or GITHUB_SHA" >&2
    exit 2
  fi
  local producer_head_sha="${PRODUCER_HEAD_SHA:-$head_sha}"

  local job_ref="" release_skip="false" skip_reason="" pr_number="" pr_head_ref=""

  case "$EVENT_NAME" in
    pull_request)
      require_env PR_NUMBER
      pr_number=$(env_value PR_NUMBER)
      local head_ref="${HEAD_REF:-}"
      pr_head_ref="$head_ref"
      if [[ "$head_ref" == release-please--branches--* ]]; then
        release_skip="true"
        skip_reason="release-please-pr"
      elif is_true "${CHECK_PR_OPEN:-false}"; then
        local state
        state=$(pr_state "$pr_number")
        if [ -z "$state" ]; then
          echo "failed to query PR #${pr_number} state" >&2
          exit 1
        fi
        if [ "$state" != "open" ]; then
          release_skip="true"
          skip_reason="pr-${state}"
        fi
      fi
      if [ "$release_skip" != "true" ]; then
        job_ref="pr-${pr_number}"
      fi
      ;;
    merge_group)
      require_env MQ_HEAD_REF
      pr_number=$(printf '%s\n' "$MQ_HEAD_REF" | grep -oE 'pr-[0-9]+' | head -1 | sed 's/pr-//' || true)
      if [ -z "$pr_number" ]; then
        echo "failed to extract PR number from merge_group head_ref: ${MQ_HEAD_REF}" >&2
        exit 1
      fi
      local branch
      branch=$(pr_branch "$pr_number")
      pr_head_ref="$branch"
      if [[ "$branch" == release-please--branches--* ]]; then
        release_skip="true"
        skip_reason="release-please-merge-queue"
      else
        job_ref="pr-${pr_number}"
      fi
      ;;
    push)
      if [[ "${COMMIT_MSG:-}" == chore:\ release* ]]; then
        release_skip="true"
        skip_reason="release-please-push"
      else
        job_ref="staging-${head_sha:0:12}"
      fi
      ;;
    *)
      echo "unsupported EVENT_NAME: ${EVENT_NAME}" >&2
      exit 2
      ;;
  esac

  emit "release-skip" "$release_skip"
  emit "skip-reason" "$skip_reason"
  emit "job-ref" "$job_ref"
  emit "head-sha" "$head_sha"
  emit "producer-head-sha" "$producer_head_sha"
  emit "pr-number" "$pr_number"
  emit "pr-head-ref" "$pr_head_ref"
}

needed() {
  require_env EVENT_NAME

  local release_skip
  release_skip=$(bool "${RELEASE_SKIP:-false}")

  local runner_host_groups_configured
  runner_host_groups_configured=$(bool "${RUNNER_HOST_GROUPS_CONFIGURED:-false}")

  local metal_hosts="${METAL_HOSTS:-}"
  local has_metal_hosts="false"
  if [ "$runner_host_groups_configured" = "true" ] || printf '%s\n' "$metal_hosts" | tr ',' '\n' | grep '[^[:space:]]' >/dev/null; then
    has_metal_hosts="true"
  fi

  local turbo_consumer
  turbo_consumer=$(bool "${TURBO_RUNNER_CONSUMER_NEEDED:-false}")
  if [ "$EVENT_NAME" = "push" ]; then
    turbo_consumer="false"
  fi

  local playwright_consumer
  playwright_consumer=$(bool "${PLAYWRIGHT_RUNNER_CONSUMER_NEEDED:-false}")

  local crates_consumer
  crates_consumer=$(bool "${CRATES_RUNNER_CONSUMER_NEEDED:-false}")

  local image_inputs_changed
  image_inputs_changed=$(bool "${RUNNER_IMAGE_INPUTS_CHANGED:-false}")

  local stable_reuse_enabled
  stable_reuse_enabled=$(bool "${STABLE_RUNNER_IMAGE_REUSE_ENABLED:-false}")

  local runner_consumer="false"
  local current_image_needed="false"
  local stable_image_allowed="false"
  local reason="no-runner-image-consumer"

  if [ "$release_skip" = "true" ]; then
    turbo_consumer="false"
    playwright_consumer="false"
    crates_consumer="false"
    image_inputs_changed="false"
    reason="release-skip"
  elif [ "$has_metal_hosts" != "true" ]; then
    turbo_consumer="false"
    playwright_consumer="false"
    crates_consumer="false"
    image_inputs_changed="false"
    reason="no-metal-hosts"
  else
    if [ "$turbo_consumer" = "true" ] ||
      [ "$playwright_consumer" = "true" ] ||
      [ "$crates_consumer" = "true" ]; then
      runner_consumer="true"
    fi

    if [ "$runner_consumer" = "true" ]; then
      if [ "$image_inputs_changed" = "true" ]; then
        current_image_needed="true"
        reason="runner-image-inputs-changed"
      else
        stable_image_allowed="true"
        if [ "$stable_reuse_enabled" = "true" ]; then
          reason="stable-runner-image-allowed"
        else
          current_image_needed="true"
          reason="runner-image-consumer-without-stable-reuse"
        fi
      fi
    fi
  fi

  emit "has-metal-hosts" "$has_metal_hosts"
  emit "turbo-runner-consumer-needed" "$turbo_consumer"
  emit "playwright-runner-consumer-needed" "$playwright_consumer"
  emit "crates-runner-consumer-needed" "$crates_consumer"
  emit "runner-image-consumer-needed" "$runner_consumer"
  emit "runner-image-inputs-changed" "$image_inputs_changed"
  emit "current-runner-image-needed" "$current_image_needed"
  emit "stable-runner-image-allowed" "$stable_image_allowed"
  emit "image-selection-reason" "$reason"
}

turbo_consumer() {
  require_env EVENT_NAME

  local consumer="false"
  if [ "$EVENT_NAME" != "push" ] && {
    is_true "${WEB_CHANGED:-false}" ||
    is_true "${API_CHANGED:-false}" ||
    is_true "${CLI_CHANGED:-false}" ||
    is_true "${CRATES_CHANGED:-false}" ||
    is_true "${CI_CHANGED:-false}" ||
    is_true "${E2E_CHANGED:-false}"
  }; then
    consumer="true"
  fi

  emit "turbo-runner-consumer-needed" "$consumer"
}

playwright_consumer() {
  local consumer="false"
  if {
    is_true "${API_CHANGED:-false}" ||
    is_true "${PLATFORM_CHANGED:-false}" ||
    is_true "${CLI_CHANGED:-false}" ||
    is_true "${CI_CHANGED:-false}" ||
    is_true "${E2E_CHANGED:-false}"
  }; then
    consumer="true"
  fi

  emit "playwright-runner-consumer-needed" "$consumer"
}

crates_consumer() {
  local consumer="false"
  if is_true "${CI_CHANGED:-false}" ||
    is_true "${RUNNER_CHANGED:-false}"; then
    consumer="true"
  fi

  emit "crates-runner-consumer-needed" "$consumer"
}

image_inputs() {
  local crate_image_inputs_changed="false"
  if is_true "${RUNNER_CHANGED:-false}"; then
    crate_image_inputs_changed="true"
  fi

  local ci_image_inputs_changed
  ci_image_inputs_changed=$(bool "${RUNNER_IMAGE_CI_CHANGED:-false}")

  local runner_image_inputs_changed="false"
  if [ "$crate_image_inputs_changed" = "true" ] || [ "$ci_image_inputs_changed" = "true" ]; then
    runner_image_inputs_changed="true"
  fi

  emit "crate-image-inputs-changed" "$crate_image_inputs_changed"
  emit "ci-image-inputs-changed" "$ci_image_inputs_changed"
  emit "runner-image-inputs-changed" "$runner_image_inputs_changed"
}

artifact_name() {
  require_env HEAD_SHA
  require_env JOB_REF
  require_env TARGET
  local head_sha job_ref target
  head_sha=$(env_value HEAD_SHA)
  job_ref=$(env_value JOB_REF)
  target=$(env_value TARGET)
  local artifact_name
  artifact_name=$(runner_image_artifact_name "$target" "$head_sha" "$job_ref")
  emit "artifact-name" "$artifact_name"
}

cmd="${1:-}"
case "$cmd" in
  resolve) resolve ;;
  turbo-consumer) turbo_consumer ;;
  playwright-consumer) playwright_consumer ;;
  crates-consumer) crates_consumer ;;
  image-inputs) image_inputs ;;
  needed) needed ;;
  artifact-name) artifact_name ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
