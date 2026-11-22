#!/usr/bin/env bash
set -euo pipefail
export ANDROID_HOME=${ANDROID_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/android-sdk}
cd android
python3 scripts/run-native-tests.py build/reports/instrumentation/logcat -- \
  ./gradlew :app:pixel2Api35Setup :app:pixel2Api35DebugAndroidTest \
  --configuration-cache --no-daemon \
  '-Pandroid.testInstrumentationRunnerArguments.class=ai.okou.android.NativeChatListTest#pendingTransportAllowsSettingsAndLoadedProjectsSurviveActivityRecreation' \
  "-Pandroid.testInstrumentationRunnerArguments.okouScreenshotRun=$OKOU_SCREENSHOT_RUN" \
  -Pandroid.testoptions.manageddevices.emulator.gpu=swiftshader_indirect \
  --stacktrace --console=plain --max-workers=2
cd ..
python3 android/scripts/screenshots.py collect android-swipe-archive-icon.png android-swipe-archive-ready.png
