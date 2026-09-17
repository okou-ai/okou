#!/usr/bin/env bash
set -euo pipefail

if [ "${DETECT_RESULT:?DETECT_RESULT is required}" != success ]; then
  echo "::error::iOS change detection must succeed; got $DETECT_RESULT"
  exit 1
fi

case "${IOS_NEEDED:-}:${BUILD_RESULT:-}" in
  true:success)
    echo "iOS app build and simulator tests passed."
    ;;
  false:skipped)
    echo "No iOS changes; simulator checks were not needed."
    ;;
  *)
    echo "::error::Unexpected iOS CI results: needed=${IOS_NEEDED:-missing}, build=${BUILD_RESULT:-missing}"
    exit 1
    ;;
esac
