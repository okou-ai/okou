#!/usr/bin/env bash
# Run the existing native suite against Release with a disposable signing key.
# Requires the README's JDK/SDK setup and KVM on Linux. Extra arguments go to Gradle.
set -euo pipefail
umask 077
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

keytool -genkeypair -keystore "$work/test.p12" -storetype PKCS12 \
  -storepass android -keypass android -alias release-test \
  -keyalg RSA -keysize 2048 -validity 1 \
  -dname 'CN=Okou Android Release Test' -noprompt

cd "$root"
export ANDROID_HOME=${ANDROID_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/android-sdk}
mkdir -p "$root/build/reports/release"
artifacts=$(mktemp -d "$root/build/reports/release/run.XXXXXX")
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'release-directory=%s\n' "$artifacts" >> "$GITHUB_OUTPUT"
fi
echo "Release test artifacts: $artifacts"
bash ../.github/scripts/artifacts/build-okou-android-apk.sh \
  "$(cat version.txt)" "$artifacts"
./gradlew :app:pixel2Api35ReleaseAndroidTest \
  -Pandroid.injected.signing.store.file="$work/test.p12" \
  -Pandroid.injected.signing.store.type=PKCS12 \
  -Pandroid.injected.signing.store.password=android \
  -Pandroid.injected.signing.key.alias=release-test \
  -Pandroid.injected.signing.key.password=android \
  --no-daemon "$@"
