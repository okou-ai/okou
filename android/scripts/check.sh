#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
export ANDROID_HOME=${ANDROID_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/android-sdk}
python3 scripts/release-signing.test.py
python3 scripts/check-auth-manifest.test.py
python3 ../.github/scripts/checks/android_launcher.py ..
python3 scripts/sync-design-tokens.py --check
./gradlew spotlessCheck :app:testDebugUnitTest \
  :app:lintDebug :app:assembleDebug --no-daemon "$@"
