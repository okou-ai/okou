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

case "${EVENT_NAME:?EVENT_NAME is required}:${IOS_NEEDED:-}:${PACKAGES_RESULT:-}:${BUILD_RESULT:-}:${ARCHIVE_RESULT:-}:${PUBLISH_RESULT:-}" in
  merge_group:true:success:success:success:success)
    echo 'Swift package tests, simulator tests or exact-input evidence, device archive, and immutable publication passed.'
    ;;
  pull_request:true:success:success:skipped:skipped | workflow_dispatch:true:success:success:skipped:skipped)
    echo 'Swift package tests, iOS app build and simulator tests passed.'
    ;;
  push:true:skipped:skipped:skipped:skipped)
    echo 'Main consumes canonical archives; native build and tests are intentionally absent.'
    ;;
  *:false:skipped:skipped:skipped:skipped)
    echo 'iOS native checks were not needed for this event.'
    ;;
  *)
    echo "::error::Unexpected iOS CI results: event=$EVENT_NAME, needed=${IOS_NEEDED:-missing}, packages=${PACKAGES_RESULT:-missing}, build=${BUILD_RESULT:-missing}, archive=${ARCHIVE_RESULT:-missing}, publish=${PUBLISH_RESULT:-missing}"
    exit 1
    ;;
esac
