#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export GRADLE_OPTS="${GRADLE_OPTS:-} -Dorg.gradle.jvmargs='-Xmx4g -Dfile.encoding=UTF-8'"
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
    phone-partial.png phone-unavailable.png wide-partial.png wide-unavailable.png
