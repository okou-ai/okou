#!/usr/bin/env bash
# Build and sign the checked-out Android release. Arguments: expected x.y.z and
# output directory. A disposable signing key exercises publication until the
# production signing owner is configured; packages cannot promise upgrade continuity.
set -euo pipefail
umask 077

if [ "$#" -ne 2 ] || [[ ! "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo 'Usage: build-okou-android-apk.sh <version> <output-directory>' >&2
  exit 2
fi
version=$1
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
if [[ "$badging" != "package: name='ai.okou.android' versionCode='"*"' versionName='$version' "* ]]; then
  echo 'Built APK package/version does not match the Android release' >&2
  exit 1
fi
"$tools/zipalign" -f -P 16 4 "$unsigned" "$work/aligned.apk"
export ANDROID_TEMP_KEYSTORE_PASSWORD
ANDROID_TEMP_KEYSTORE_PASSWORD=$(python3 -c 'import secrets; print(secrets.token_hex(24))')
keytool -genkeypair -noprompt -storetype PKCS12 \
  -keystore "$work/release.keystore" -alias okou-temporary \
  -storepass:env ANDROID_TEMP_KEYSTORE_PASSWORD -keypass:env ANDROID_TEMP_KEYSTORE_PASSWORD \
  -dname 'CN=Okou Temporary Android, O=Okou' -keyalg RSA -keysize 2048 -validity 365
"$tools/apksigner" sign \
  --ks "$work/release.keystore" --ks-key-alias okou-temporary \
  --ks-pass env:ANDROID_TEMP_KEYSTORE_PASSWORD --key-pass env:ANDROID_TEMP_KEYSTORE_PASSWORD \
  --out "$work/okou-android-$version.apk" "$work/aligned.apk"
"$tools/apksigner" verify "$work/okou-android-$version.apk"
"$tools/zipalign" -c -P 16 4 "$work/okou-android-$version.apk"
mkdir -p "$output"
# Refuse to overwrite a caller's existing output.
(
  set -o noclobber
  cat "$work/okou-android-$version.apk" > "$output/okou-android-$version.apk"
)
echo "Signed Android APK: $output/okou-android-$version.apk"
