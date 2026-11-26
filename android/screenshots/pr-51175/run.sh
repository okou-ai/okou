#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export GRADLE_OPTS="${GRADLE_OPTS:-} -Dorg.gradle.jvmargs='-Xmx4g -Dfile.encoding=UTF-8'"
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
    phone-unread-retry.png phone-unread-reopened.png phone-unread-refreshed.png \
    wide-inbox-retry.png wide-inbox-reopened.png wide-inbox-refreshed.png
