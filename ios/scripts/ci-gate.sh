#!/usr/bin/env bash
set -euo pipefail

if [ "${RELEASE_DETECT_RESULT:?RELEASE_DETECT_RESULT is required}" != success ]; then
  echo '::error::iOS release classification must succeed'
  exit 1
fi
case "${IS_RELEASE:-}" in
  true)
    if [ "${DETECT_RESULT:-}" != success ]; then
      echo '::error::Release archive selection must succeed'
      exit 1
    fi
    case "${EVENT_NAME:?}:${IOS_NEEDED:-}:${ARCHIVE_RESULT:-}:${PUBLISH_RESULT:-}" in
      merge_group:true:success:success | merge_group:false:skipped:skipped | pull_request:false:skipped:skipped | push:true:skipped:skipped | push:false:skipped:skipped) ;;
      *) echo '::error::Release-please requires an explicit archive selection and publication'; exit 1 ;;
    esac
    echo 'Release-please: native validation skipped; required release artifacts are ready.'
    exit 0
    ;;
  false) ;;
  *) echo '::error::Missing or invalid iOS release selection'; exit 1 ;;
esac

if [ "${DETECT_RESULT:?DETECT_RESULT is required}" != success ]; then
  echo "::error::iOS change detection must succeed; got $DETECT_RESULT"
  exit 1
fi

if [ "${SCRIPT_CHECKS_RESULT:?SCRIPT_CHECKS_RESULT is required}" != success ]; then
  echo "::error::iOS script checks must succeed; got $SCRIPT_CHECKS_RESULT"
  exit 1
fi

case "${IOS_NEEDED:-}:${LINT_RESULT:-}" in
  true:success | false:skipped) ;;
  *)
    echo "::error::Unexpected SwiftLint result: needed=${IOS_NEEDED:-missing}, lint=${LINT_RESULT:-missing}"
    exit 1
    ;;
esac

case "${EVENT_NAME:?EVENT_NAME is required}:${IOS_NEEDED:-}:${PREVIEW_RESULT:-}" in
  pull_request:true:success | workflow_dispatch:true:success | merge_group:true:skipped | push:true:skipped | *:false:skipped) ;;
  *)
    echo "::error::Unexpected staging device build: event=$EVENT_NAME, needed=${IOS_NEEDED:-missing}, preview=${PREVIEW_RESULT:-missing}"
    exit 1
    ;;
esac

case "${EVENT_NAME:?EVENT_NAME is required}:${IOS_NEEDED:-}:${PACKAGES_RESULT:-}:${BUILD_RESULT:-}:${ARCHIVE_RESULT:-}:${PUBLISH_RESULT:-}" in
  merge_group:true:success:success:success:success)
    echo 'Swift package tests, simulator tests or exact-input evidence, device archive, and immutable publication passed.'
    ;;
  pull_request:true:success:success:skipped:skipped | workflow_dispatch:true:success:success:skipped:skipped)
    echo 'Swift package tests, iOS app build, simulator tests, and staging device artifacts passed.'
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
