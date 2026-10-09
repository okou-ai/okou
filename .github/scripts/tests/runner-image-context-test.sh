#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CONTEXT="${SCRIPT_DIR}/runner-image-context.sh"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_contains() {
  local output=$1 expected=$2
  grep -qxF "$expected" <<<"$output" || fail "expected line '${expected}' in output: ${output}"
}

assert_not_prefix() {
  local output=$1 prefix=$2
  if grep -q "^${prefix}" <<<"$output"; then
    fail "unexpected output prefix '${prefix}' in output: ${output}"
  fi
}

run_clean() {
  env -i PATH="$PATH" HOME="${HOME:-/tmp}" "$@"
}

assert_fails() {
  local name=$1
  shift
  if run_clean "$@" >/dev/null 2>&1; then
    fail "expected failure: ${name}"
  fi
}

assert_no_legacy_needed_outputs() {
  local out=$1
  assert_not_prefix "$out" "turbo-runner-needed="
  assert_not_prefix "$out" "crates-runner-needed="
  assert_not_prefix "$out" "runner-image-needed="
}

assert_needed_case() {
  local name=$1
  shift
  local out
  if ! out=$(run_clean "$@" "$CONTEXT" needed); then
    fail "needed case failed: ${name}"
  fi
  assert_no_legacy_needed_outputs "$out"
  printf '%s\n' "$out"
}

out=$(run_clean EVENT_NAME=pull_request PR_NUMBER=123 HEAD_REF=feature HEAD_SHA=merge PRODUCER_HEAD_SHA=head "$CONTEXT" resolve)
assert_contains "$out" "release-skip=false"
assert_contains "$out" "job-ref=pr-123"
assert_contains "$out" "head-sha=merge"
assert_contains "$out" "producer-head-sha=head"
assert_contains "$out" "pr-number=123"
assert_contains "$out" "pr-head-ref=feature"

out=$(run_clean EVENT_NAME=pull_request PR_NUMBER=123 HEAD_REF=release-please--branches--main HEAD_SHA=abc "$CONTEXT" resolve)
assert_contains "$out" "release-skip=true"
assert_contains "$out" "skip-reason=release-please-pr"
assert_contains "$out" "job-ref="
assert_contains "$out" "pr-number=123"
assert_contains "$out" "pr-head-ref=release-please--branches--main"

out=$(run_clean EVENT_NAME=merge_group MQ_HEAD_REF=refs/heads/gh-readonly-queue/main/pr-456-abc MOCK_PR_BRANCH=feature HEAD_SHA=def "$CONTEXT" resolve)
assert_contains "$out" "release-skip=false"
assert_contains "$out" "job-ref=pr-456"
assert_contains "$out" "pr-number=456"
assert_contains "$out" "pr-head-ref=feature"
assert_contains "$out" "head-sha=def"
assert_contains "$out" "producer-head-sha=def"

out=$(run_clean EVENT_NAME=merge_group MQ_HEAD_REF=refs/heads/gh-readonly-queue/main/pr-456-abc MOCK_PR_BRANCH=release-please--branches--main HEAD_SHA=def "$CONTEXT" resolve)
assert_contains "$out" "release-skip=true"
assert_contains "$out" "skip-reason=release-please-merge-queue"
assert_contains "$out" "job-ref="
assert_contains "$out" "pr-number=456"
assert_contains "$out" "pr-head-ref=release-please--branches--main"

out=$(run_clean EVENT_NAME=push COMMIT_MSG='regular commit' HEAD_SHA=ghi "$CONTEXT" resolve)
assert_contains "$out" "release-skip=false"
assert_contains "$out" "job-ref=staging-ghi"
assert_contains "$out" "pr-number="
assert_contains "$out" "pr-head-ref="
assert_contains "$out" "head-sha=ghi"
assert_contains "$out" "producer-head-sha=ghi"

out=$(run_clean EVENT_NAME=push COMMIT_MSG='chore: release 1.2.3' HEAD_SHA=ghi "$CONTEXT" resolve)
assert_contains "$out" "release-skip=true"
assert_contains "$out" "skip-reason=release-please-push"
assert_contains "$out" "job-ref="

assert_fails "turbo-consumer requires EVENT_NAME" \
  WEB_CHANGED=true \
  "$CONTEXT" turbo-consumer

for flag in WEB_CHANGED API_CHANGED CLI_CHANGED CRATES_CHANGED CI_CHANGED E2E_CHANGED; do
  out=$(run_clean \
    EVENT_NAME=pull_request \
    "${flag}=true" \
    "$CONTEXT" turbo-consumer)
  assert_contains "$out" "turbo-runner-consumer-needed=true"
done

out=$(run_clean \
  EVENT_NAME=merge_group \
  API_CHANGED=true \
  "$CONTEXT" turbo-consumer)
assert_contains "$out" "turbo-runner-consumer-needed=true"

out=$(run_clean \
  EVENT_NAME=push \
  WEB_CHANGED=true \
  "$CONTEXT" turbo-consumer)
assert_contains "$out" "turbo-runner-consumer-needed=false"

out=$(run_clean "$CONTEXT" playwright-consumer)
assert_contains "$out" "playwright-runner-consumer-needed=false"

for flag in API_CHANGED PLATFORM_CHANGED CLI_CHANGED CI_CHANGED E2E_CHANGED; do
  out=$(run_clean \
    "${flag}=true" \
    "$CONTEXT" playwright-consumer)
  assert_contains "$out" "playwright-runner-consumer-needed=true"
done

for flag in CI_CHANGED RUNNER_CHANGED; do
  out=$(run_clean \
    "${flag}=true" \
    "$CONTEXT" crates-consumer)
  assert_contains "$out" "crates-runner-consumer-needed=true"
done

out=$(run_clean "$CONTEXT" crates-consumer)
assert_contains "$out" "crates-runner-consumer-needed=false"

out=$(run_clean "$CONTEXT" image-inputs)
assert_contains "$out" "crate-image-inputs-changed=false"
assert_contains "$out" "ci-image-inputs-changed=false"
assert_contains "$out" "runner-image-inputs-changed=false"

out=$(run_clean \
  RUNNER_CHANGED=true \
  "$CONTEXT" image-inputs)
assert_contains "$out" "crate-image-inputs-changed=true"
assert_contains "$out" "ci-image-inputs-changed=false"
assert_contains "$out" "runner-image-inputs-changed=true"

out=$(run_clean \
  RUNNER_IMAGE_CI_CHANGED=true \
  "$CONTEXT" image-inputs)
assert_contains "$out" "crate-image-inputs-changed=false"
assert_contains "$out" "ci-image-inputs-changed=true"
assert_contains "$out" "runner-image-inputs-changed=true"

assert_fails "needed requires EVENT_NAME" \
  RELEASE_SKIP=false \
  METAL_HOSTS=dev-1 \
  PLAYWRIGHT_RUNNER_CONSUMER_NEEDED=true \
  "$CONTEXT" needed

out=$(assert_needed_case "release skip" \
  EVENT_NAME=pull_request \
  RELEASE_SKIP=true \
  METAL_HOSTS=dev-1 \
  PLAYWRIGHT_RUNNER_CONSUMER_NEEDED=true \
  RUNNER_IMAGE_INPUTS_CHANGED=true)
assert_contains "$out" "has-metal-hosts=true"
assert_contains "$out" "playwright-runner-consumer-needed=false"
assert_contains "$out" "crates-runner-consumer-needed=false"
assert_contains "$out" "runner-image-consumer-needed=false"
assert_contains "$out" "runner-image-inputs-changed=false"
assert_contains "$out" "current-runner-image-needed=false"
assert_contains "$out" "stable-runner-image-allowed=false"
assert_contains "$out" "image-selection-reason=release-skip"

out=$(assert_needed_case "release skip with runner host groups" \
  EVENT_NAME=pull_request \
  RELEASE_SKIP=true \
  RUNNER_HOST_GROUPS_CONFIGURED=true \
  PLAYWRIGHT_RUNNER_CONSUMER_NEEDED=true \
  RUNNER_IMAGE_INPUTS_CHANGED=true)
assert_contains "$out" "has-metal-hosts=true"
assert_contains "$out" "playwright-runner-consumer-needed=false"
assert_contains "$out" "crates-runner-consumer-needed=false"
assert_contains "$out" "runner-image-consumer-needed=false"
assert_contains "$out" "runner-image-inputs-changed=false"
assert_contains "$out" "current-runner-image-needed=false"
assert_contains "$out" "stable-runner-image-allowed=false"
assert_contains "$out" "image-selection-reason=release-skip"

out=$(assert_needed_case "no metal hosts" \
  EVENT_NAME=pull_request \
  RELEASE_SKIP=false \
  METAL_HOSTS= \
  PLAYWRIGHT_RUNNER_CONSUMER_NEEDED=true \
  RUNNER_IMAGE_INPUTS_CHANGED=true)
assert_contains "$out" "has-metal-hosts=false"
assert_contains "$out" "runner-image-consumer-needed=false"
assert_contains "$out" "runner-image-inputs-changed=false"
assert_contains "$out" "current-runner-image-needed=false"
assert_contains "$out" "image-selection-reason=no-metal-hosts"

out=$(assert_needed_case "no runner host groups" \
  EVENT_NAME=pull_request \
  RELEASE_SKIP=false \
  RUNNER_HOST_GROUPS_CONFIGURED=false \
  PLAYWRIGHT_RUNNER_CONSUMER_NEEDED=true \
  RUNNER_IMAGE_INPUTS_CHANGED=true)
assert_contains "$out" "has-metal-hosts=false"
assert_contains "$out" "runner-image-consumer-needed=false"
assert_contains "$out" "runner-image-inputs-changed=false"
assert_contains "$out" "current-runner-image-needed=false"
assert_contains "$out" "image-selection-reason=no-metal-hosts"

out=$(assert_needed_case "runner host group without legacy metal hosts" \
  EVENT_NAME=pull_request \
  RELEASE_SKIP=false \
  RUNNER_HOST_GROUPS_CONFIGURED=true \
  PLAYWRIGHT_RUNNER_CONSUMER_NEEDED=true \
  RUNNER_IMAGE_INPUTS_CHANGED=true)
assert_contains "$out" "has-metal-hosts=true"
assert_contains "$out" "playwright-runner-consumer-needed=true"
assert_contains "$out" "runner-image-consumer-needed=true"
assert_contains "$out" "runner-image-inputs-changed=true"
assert_contains "$out" "current-runner-image-needed=true"
assert_contains "$out" "image-selection-reason=runner-image-inputs-changed"

out=$(assert_needed_case "no consumer" \
  EVENT_NAME=pull_request \
  RELEASE_SKIP=false \
  METAL_HOSTS=dev-1 \
  RUNNER_IMAGE_INPUTS_CHANGED=true)
assert_contains "$out" "has-metal-hosts=true"
assert_contains "$out" "playwright-runner-consumer-needed=false"
assert_contains "$out" "crates-runner-consumer-needed=false"
assert_contains "$out" "runner-image-consumer-needed=false"
assert_contains "$out" "runner-image-inputs-changed=true"
assert_contains "$out" "current-runner-image-needed=false"
assert_contains "$out" "stable-runner-image-allowed=false"
assert_contains "$out" "image-selection-reason=no-runner-image-consumer"

out=$(assert_needed_case "Turbo runner E2E consumer" \
  EVENT_NAME=pull_request \
  RELEASE_SKIP=false \
  METAL_HOSTS=dev-1 \
  TURBO_RUNNER_CONSUMER_NEEDED=true \
  RUNNER_IMAGE_INPUTS_CHANGED=false)
assert_contains "$out" "turbo-runner-consumer-needed=true"
assert_contains "$out" "playwright-runner-consumer-needed=false"
assert_contains "$out" "runner-image-consumer-needed=true"
assert_contains "$out" "stable-runner-image-allowed=true"
assert_contains "$out" "current-runner-image-needed=true"

out=$(assert_needed_case "crates ci-only consumer before stable reuse" \
  EVENT_NAME=pull_request \
  RELEASE_SKIP=false \
  METAL_HOSTS=dev-1 \
  CRATES_RUNNER_CONSUMER_NEEDED=true \
  RUNNER_IMAGE_INPUTS_CHANGED=false)
assert_contains "$out" "playwright-runner-consumer-needed=false"
assert_contains "$out" "crates-runner-consumer-needed=true"
assert_contains "$out" "runner-image-consumer-needed=true"
assert_contains "$out" "runner-image-inputs-changed=false"
assert_contains "$out" "stable-runner-image-allowed=true"
assert_contains "$out" "current-runner-image-needed=true"
assert_contains "$out" "image-selection-reason=runner-image-consumer-without-stable-reuse"

out=$(assert_needed_case "main Playwright runner consumer" \
  EVENT_NAME=push \
  RELEASE_SKIP=false \
  METAL_HOSTS=dev-1 \
  PLAYWRIGHT_RUNNER_CONSUMER_NEEDED=true \
  RUNNER_IMAGE_INPUTS_CHANGED=false)
assert_contains "$out" "playwright-runner-consumer-needed=true"
assert_contains "$out" "crates-runner-consumer-needed=false"
assert_contains "$out" "runner-image-consumer-needed=true"
assert_contains "$out" "runner-image-inputs-changed=false"
assert_contains "$out" "stable-runner-image-allowed=true"
assert_contains "$out" "current-runner-image-needed=true"
assert_contains "$out" "image-selection-reason=runner-image-consumer-without-stable-reuse"

out=$(assert_needed_case "crates runner input" \
  EVENT_NAME=push \
  RELEASE_SKIP=false \
  METAL_HOSTS=dev-1 \
  CRATES_RUNNER_CONSUMER_NEEDED=true \
  RUNNER_IMAGE_INPUTS_CHANGED=true)
assert_contains "$out" "playwright-runner-consumer-needed=false"
assert_contains "$out" "crates-runner-consumer-needed=true"
assert_contains "$out" "runner-image-consumer-needed=true"
assert_contains "$out" "runner-image-inputs-changed=true"
assert_contains "$out" "stable-runner-image-allowed=false"
assert_contains "$out" "current-runner-image-needed=true"
assert_contains "$out" "image-selection-reason=runner-image-inputs-changed"

out=$(assert_needed_case "Turbo runner E2E ignored on push" \
  EVENT_NAME=push \
  RELEASE_SKIP=false \
  METAL_HOSTS=dev-1 \
  TURBO_RUNNER_CONSUMER_NEEDED=true \
  RUNNER_IMAGE_INPUTS_CHANGED=false)
assert_contains "$out" "turbo-runner-consumer-needed=false"
assert_contains "$out" "runner-image-consumer-needed=false"
assert_contains "$out" "current-runner-image-needed=false"

out=$(assert_needed_case "guest input" \
  EVENT_NAME=pull_request \
  RELEASE_SKIP=false \
  METAL_HOSTS=dev-1 \
  CRATES_RUNNER_CONSUMER_NEEDED=true \
  RUNNER_IMAGE_INPUTS_CHANGED=true)
assert_contains "$out" "crates-runner-consumer-needed=true"
assert_contains "$out" "runner-image-inputs-changed=true"
assert_contains "$out" "current-runner-image-needed=true"

assert_fails "artifact-name requires TARGET" \
  HEAD_SHA=abc \
  JOB_REF=pr-123 \
  "$CONTEXT" artifact-name

assert_fails "artifact-name rejects unsupported TARGET" \
  HEAD_SHA=abc \
  JOB_REF=pr-123 \
  TARGET=powerpc-unknown-linux-musl \
  "$CONTEXT" artifact-name

out=$(run_clean HEAD_SHA=abc JOB_REF=pr-123 TARGET=aarch64-unknown-linux-musl "$CONTEXT" artifact-name)
assert_contains "$out" "artifact-name=runner-image-manifest-aarch64-unknown-linux-musl-abc-pr-123"

out=$(run_clean HEAD_SHA=abc JOB_REF=pr-123 TARGET=x86_64-unknown-linux-musl "$CONTEXT" artifact-name)
assert_contains "$out" "artifact-name=runner-image-manifest-x86_64-unknown-linux-musl-abc-pr-123"

grep -qF "HEAD_SHA: \${{ github.sha }}" \
  "${REPO_ROOT}/.github/workflows/runner-image.yml" \
  || fail "build identity must use the captured event revision"
grep -qF "PRODUCER_HEAD_SHA: \${{ github.event.pull_request.head.sha || github.sha }}" \
  "${REPO_ROOT}/.github/workflows/runner-image.yml" \
  || fail "workflow must distinguish the Actions API head from the build merge SHA"
grep -qF "PRODUCER_HEAD_SHA: \${{ needs.prepare.outputs.producer-head-sha }}" \
  "${REPO_ROOT}/.github/workflows/runner-image.yml" \
  || fail "reusable provenance must use the Actions API head SHA"

echo "runner-image-context-test: ok"
