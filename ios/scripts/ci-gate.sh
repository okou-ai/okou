#!/usr/bin/env bash
set -euo pipefail

if [ "${DETECT_RESULT:?DETECT_RESULT is required}" != success ]; then
  echo "::error::iOS change detection must succeed; got $DETECT_RESULT"
  exit 1
fi

case "${EVENT_NAME:?EVENT_NAME is required}:${IOS_NEEDED:-}:${BUILD_RESULT:-}:${PUBLISH_RESULT:-}" in
  merge_group:true:success:success)
    echo 'iOS tests or exact-input test evidence, device archive, and immutable publication passed.'
    ;;
  pull_request:true:success:skipped | workflow_dispatch:true:success:skipped)
    echo 'iOS app build and simulator tests passed.'
    ;;
  push:true:skipped:skipped)
    echo 'Main consumes canonical archives; native build and tests are intentionally absent.'
    ;;
  *:false:skipped:skipped)
    echo 'iOS native checks were not needed for this event.'
    ;;
  *)
    echo "::error::Unexpected iOS CI results: event=$EVENT_NAME, needed=${IOS_NEEDED:-missing}, build=${BUILD_RESULT:-missing}, publish=${PUBLISH_RESULT:-missing}"
    exit 1
    ;;
esac
