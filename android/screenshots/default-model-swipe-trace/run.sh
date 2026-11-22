#!/usr/bin/env bash
set -euo pipefail

export ANDROID_HOME=${ANDROID_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/android-sdk}
: "${OKOU_SCREENSHOT_RUN:?Invoke through screenshots.py run}"
: "${OKOU_SCREENSHOT_OUTPUT:?Invoke through screenshots.py run}"
cd android
python3 scripts/run-native-tests.py "$OKOU_SCREENSHOT_OUTPUT/logcat" -- \
  ./gradlew :app:pixel2Api35DebugAndroidTest --no-daemon \
  "-Pandroid.testInstrumentationRunnerArguments.okouScreenshotRun=$OKOU_SCREENSHOT_RUN" \
  -Pandroid.testoptions.manageddevices.emulator.gpu=swiftshader_indirect \
  --stacktrace --console=plain
python3 scripts/check-native-results.py \
  app/build/outputs/androidTest-results/managedDevice/debug/pixel2Api35 12
cd ..
python3 android/scripts/screenshots.py collect chat-list-swipe-verified.png
