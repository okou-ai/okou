#!/usr/bin/env bash
# Build and align the checked-out Android release without signing credentials.
# Arguments: expected x.y.z and output directory. Requires ANDROID_HOME and JDK.
set -euo pipefail
umask 077

if [ "$#" -ne 2 ] || [[ ! "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo 'Usage: build-okou-android-apk.sh <version> <output-directory>' >&2
  exit 2
fi
version=$1
version_code=$(python3 - "$version" <<'PY'
import sys
major, minor, patch = map(int, sys.argv[1].split('.'))
code = major * 1_000_000 + minor * 1_000 + patch
if minor >= 1000 or patch >= 1000 or not 0 < code <= 2_147_483_647:
    raise SystemExit('Android version does not fit versionCode')
print(code)
PY
)
output=$(realpath -m "$2")
root=$(git rev-parse --show-toplevel)
[ "$(cat "$root/android/version.txt")" = "$version" ] || {
  echo 'Android release version does not match version.txt' >&2
  exit 1
}
: "${ANDROID_HOME:?Android SDK is required}"
tools="$ANDROID_HOME/build-tools/35.0.0"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$root/android"
./gradlew :app:assembleRelease --no-daemon
unsigned="$root/android/app/build/outputs/apk/release/app-release-unsigned.apk"
badging=$("$tools/aapt" dump badging "$unsigned")
if [[ "$badging" != "package: name='ai.okou.android' versionCode='$version_code' versionName='$version' "* ]]; then
  echo 'Built APK package/version does not match the Android release' >&2
  exit 1
fi
"$tools/zipalign" -f -P 16 4 "$unsigned" "$work/aligned.apk"
"$tools/zipalign" -c -P 16 4 "$work/aligned.apk"
mkdir -p "$output"
# Refuse to overwrite a caller's existing output.
(
  set -o noclobber
  cat "$work/aligned.apk" > "$output/okou-android-$version-unsigned.apk"
)
echo "Unsigned Android APK: $output/okou-android-$version-unsigned.apk"
