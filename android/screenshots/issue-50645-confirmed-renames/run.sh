#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# Match the Android CI Gradle heap for APK packaging on the managed runner.
export GRADLE_OPTS="${GRADLE_OPTS:-} -Dorg.gradle.jvmargs='-Xmx4g -Dfile.encoding=UTF-8'"
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
    phone-chat-saving.png phone-chat-confirmed.png \
    wide-project-saving.png wide-project-confirmed.png wide-project-rejected.png \
    phone-chat-unconfirmed.png phone-chat-confirmed-after-later-rename.png \
    wide-project-unconfirmed-row.png wide-project-check-result.png \
    phone-chat-live-baseline.png phone-chat-live-draft.png
