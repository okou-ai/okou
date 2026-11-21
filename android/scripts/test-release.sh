#!/usr/bin/env bash
# Sign the exact publishing payload before exercising it on an isolated emulator.
set -euo pipefail
umask 077
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
export ANDROID_HOME=${ANDROID_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/android-sdk}
cd "$root"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

keytool -genkeypair -keystore "$work/test.p12" -storetype PKCS12 \
  -storepass android -keypass android -alias release-test \
  -keyalg RSA -keysize 2048 -validity 1 -dname 'CN=Okou Android Release Smoke' -noprompt

version=$(cat version.txt)
mkdir -p build/reports/release
artifacts=$(mktemp -d "$root/build/reports/release/run.XXXXXX")
bash ../.github/scripts/artifacts/build-okou-android-apk.sh "$version" "$artifacts"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'release-directory=%s\n' "$artifacts" >> "$GITHUB_OUTPUT"
fi
unsigned="$artifacts/okou-android-$version-unsigned.apk"
mapping="$artifacts/okou-android-$version-mapping.txt.gz"
signed="$artifacts/tested-app.apk"
ANDROID_RELEASE_KEYSTORE_BASE64=$(base64 < "$work/test.p12") \
  ANDROID_RELEASE_KEYSTORE_PASSWORD=android ANDROID_RELEASE_KEY_ALIAS=release-test \
  bash ../.github/scripts/artifacts/sign-okou-android-apk.sh "$version" "$unsigned" "$signed"
python3 scripts/verify-release-pair.py "$unsigned" "$mapping" "$signed" \
  app/build/outputs/mapping/release/mapping.txt "$artifacts/pair-identity.json"
python3 scripts/release-smoke.py "$signed" "$artifacts"
