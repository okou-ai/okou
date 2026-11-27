#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export GRADLE_OPTS="${GRADLE_OPTS:-} -Dorg.gradle.jvmargs='-Xmx4g -Dfile.encoding=UTF-8'"
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
    phone-unread-failure.png phone-project-failure.png \
    wide-unread-failure.png wide-project-failure.png
