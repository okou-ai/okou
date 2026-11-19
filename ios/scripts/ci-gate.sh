#!/usr/bin/env bash
set -euo pipefail

if [ "${DETECT_RESULT:?DETECT_RESULT is required}" != success ]; then
  echo "::error::iOS change detection must succeed; got $DETECT_RESULT"
  exit 1
fi

if [ "${SCRIPT_CHECKS_RESULT:?SCRIPT_CHECKS_RESULT is required}" != success ]; then
  echo "::error::iOS script checks must succeed; got $SCRIPT_CHECKS_RESULT"
  exit 1
fi

# Only a main merge group whose resolver verified a published archive and its
# tests may omit native jobs. A skipped resolver selects the ordinary path.
case "${EVENT_NAME:?EVENT_NAME is required}:${IOS_NEEDED:-}:${RELEASE_RESULT:?RELEASE_RESULT is required}:${RELEASE_REUSE:-}" in
  merge_group:true:success:true) release_reuse=true ;;
  merge_group:true:success:false | *:*:skipped:) release_reuse=false ;;
  *)
    echo "::error::Unexpected release resolution: event=$EVENT_NAME, needed=${IOS_NEEDED:-missing}, result=$RELEASE_RESULT, reuse=${RELEASE_REUSE:-missing}"
    exit 1
    ;;
esac

case "${IOS_NEEDED:-}:$release_reuse:${LINT_RESULT:-}" in
  true:false:success | true:true:skipped | false:false:skipped) ;;
  *)
    echo "::error::Unexpected SwiftLint result: needed=${IOS_NEEDED:-missing}, lint=${LINT_RESULT:-missing}"
    exit 1
    ;;
esac

case "$EVENT_NAME:${IOS_NEEDED:-}:${PREVIEW_RESULT:-}" in
  pull_request:true:success | workflow_dispatch:true:success | merge_group:true:skipped | push:true:skipped | *:false:skipped) ;;
  *)
    echo "::error::Unexpected staging device build: event=$EVENT_NAME, needed=${IOS_NEEDED:-missing}, preview=${PREVIEW_RESULT:-missing}"
    exit 1
    ;;
esac

case "$EVENT_NAME:${IOS_NEEDED:-}:$release_reuse:${PACKAGES_RESULT:-}:${BUILD_RESULT:-}:${ARCHIVE_RESULT:-}:${PUBLISH_RESULT:-}" in
  merge_group:true:false:success:success:success:success)
    echo 'Swift package tests, simulator tests or exact-input evidence, device archive, and immutable publication passed.'
    ;;
  merge_group:true:true:skipped:skipped:skipped:skipped)
    echo 'Release metadata reused exact-input test evidence and the published device archive.'
    ;;
  pull_request:true:false:success:success:skipped:skipped | workflow_dispatch:true:false:success:success:skipped:skipped)
    echo 'Swift package tests, iOS app build, simulator tests, and staging device artifacts passed.'
    ;;
  push:true:false:skipped:skipped:skipped:skipped)
    echo 'Main consumes canonical archives; native build and tests are intentionally absent.'
    ;;
  *:false:false:skipped:skipped:skipped:skipped)
    echo 'iOS native checks were not needed for this event.'
    ;;
  *)
    echo "::error::Unexpected iOS CI results: event=$EVENT_NAME, needed=${IOS_NEEDED:-missing}, packages=${PACKAGES_RESULT:-missing}, build=${BUILD_RESULT:-missing}, archive=${ARCHIVE_RESULT:-missing}, publish=${PUBLISH_RESULT:-missing}"
    exit 1
    ;;
esac
