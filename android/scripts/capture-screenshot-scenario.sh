#!/usr/bin/env bash
# Called by a PR recipe: <scenario directory> <required image.png> [...].
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"
scenario=$(python3 android/scripts/screenshots.py validate "$@")
shift
export ANDROID_HOME=${ANDROID_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/android-sdk}
: "${OKOU_SCREENSHOT_RUN:?Invoke the recipe through screenshots.py run}"
cd android
./gradlew :app:pixel2Api35DebugAndroidTest \
  "-Pokou.screenshotScenarioDir=$scenario" \
  -Pandroid.testInstrumentationRunnerArguments.class=ai.okou.android.screenshots.ScreenshotScenario \
  "-Pandroid.testInstrumentationRunnerArguments.okouScreenshotRun=$OKOU_SCREENSHOT_RUN" \
  -Pandroid.testoptions.manageddevices.emulator.gpu=swiftshader_indirect \
  --no-daemon --stacktrace --console=plain --max-workers=2
cd "$root"
python3 android/scripts/screenshots.py collect "$@"
