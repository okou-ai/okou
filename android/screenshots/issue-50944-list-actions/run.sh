#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export GRADLE_OPTS="${GRADLE_OPTS:-} -Dorg.gradle.jvmargs='-Xmx4g -Dfile.encoding=UTF-8'"
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
    phone-list.png phone-rename.png wide-list.png wide-delete-ready.png \
    wide-delete-pending.png wide-delete-rejected.png
