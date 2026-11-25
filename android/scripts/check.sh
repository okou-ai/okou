#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
export ANDROID_HOME=${ANDROID_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/android-sdk}
python3 scripts/release-signing.test.py
python3 scripts/release-diagnostics.test.py
python3 scripts/retrace-release.test.py
python3 scripts/version-code.test.py
python3 scripts/check-auth-manifest.test.py
python3 scripts/screenshots.test.py
python3 scripts/check-saved-state.test.py
python3 scripts/check-jvm-test-counts.test.py
python3 scripts/check-saved-state.py
python3 ../.github/scripts/checks/android_launcher.py ..
pnpm --dir scripts/theme install --frozen-lockfile --ignore-scripts
node scripts/theme/generate.mjs --check
./gradlew spotlessCheck :app:testDebugUnitTest \
  :app:lintDebug :app:assembleDebug --no-daemon "$@"
