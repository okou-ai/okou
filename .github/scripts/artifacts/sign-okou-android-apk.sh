#!/usr/bin/env bash
# Sign an aligned release APK using the three production signing inputs.
# Arguments: x.y.z, unsigned APK, output APK (must not exist). Requires JDK,
# Python 3 and ANDROID_HOME/build-tools/35.0.0. No Gradle or remote writes.
set +x
set -euo pipefail
umask 077

if [ "$#" -ne 3 ] || [[ ! "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo 'Usage: sign-okou-android-apk.sh <version> <unsigned-apk> <output-apk>' >&2
  exit 2
fi
version=$1
unsigned=$(realpath "$2")
output=$(realpath -m "$3")
[ ! -e "$output" ] || { echo 'Refusing to overwrite an existing APK' >&2; exit 1; }
: "${ANDROID_HOME:?Android SDK is required}"
: "${ANDROID_RELEASE_KEYSTORE_BASE64:?Release keystore is required}"
: "${ANDROID_RELEASE_KEYSTORE_PASSWORD:?Release keystore password is required}"
: "${ANDROID_RELEASE_KEY_ALIAS:?Release key alias is required}"
tools="$ANDROID_HOME/build-tools/35.0.0"
version_code=$(python3 - "$version" <<'PY'
import sys
major, minor, patch = map(int, sys.argv[1].split('.'))
code = major * 1_000_000 + minor * 1_000 + patch
if minor >= 1000 or patch >= 1000 or not 0 < code <= 2_147_483_647:
    raise SystemExit('Android version does not fit versionCode')
print(code)
PY
)
badging=$("$tools/aapt" dump badging "$unsigned")
if [[ "$badging" != "package: name='ai.okou.android' versionCode='$version_code' versionName='$version' "* ]]; then
  echo 'Unsigned APK package/version does not match the Android release' >&2
  exit 1
fi
"$tools/zipalign" -c -P 16 4 "$unsigned"

# Stage on the output filesystem so the final no-clobber hard link is atomic.
work=$(mktemp -d "$(dirname "$output")/android-signing.XXXXXX")
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 - "$work/release.p12" <<'PY'
import base64
import binascii
import os
from pathlib import Path
import sys
try:
    encoded = ''.join(os.environ['ANDROID_RELEASE_KEYSTORE_BASE64'].split())
    decoded = base64.b64decode(encoded, validate=True)
    if not decoded:
        raise ValueError('empty keystore')
except (ValueError, binascii.Error):
    raise SystemExit('Invalid release keystore Base64') from None
Path(sys.argv[1]).write_bytes(decoded)
PY
unset ANDROID_RELEASE_KEYSTORE_BASE64
# Keep diagnostics from private-container parsing out of public logs.
if ! keytool -exportcert -storetype PKCS12 -keystore "$work/release.p12" \
  -alias "$ANDROID_RELEASE_KEY_ALIAS" -storepass:env ANDROID_RELEASE_KEYSTORE_PASSWORD \
  > "$work/certificate.der" 2> "$work/keytool.log"; then
  echo 'Cannot read the release PKCS12 certificate; check the password and alias' >&2
  exit 1
fi
if ! "$tools/apksigner" sign --ks "$work/release.p12" \
  --ks-key-alias "$ANDROID_RELEASE_KEY_ALIAS" \
  --ks-pass env:ANDROID_RELEASE_KEYSTORE_PASSWORD \
  --key-pass env:ANDROID_RELEASE_KEYSTORE_PASSWORD --v4-signing-enabled false \
  --out "$work/signed.apk" "$unsigned" > "$work/sign.log" 2>&1; then
  echo 'Android release signing failed' >&2
  exit 1
fi
"$tools/apksigner" verify --verbose --print-certs "$work/signed.apk" > "$work/verification.txt"
python3 - "$work/certificate.der" "$work/verification.txt" <<'PY'
import hashlib
from pathlib import Path
import re
import sys
expected = hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest()
actual = re.findall(r'^Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F]+)$',
                    Path(sys.argv[2]).read_text(), re.M)
if [digest.lower() for digest in actual] != [expected]:
    raise SystemExit('APK signer does not match the selected keystore alias')
print(f'Verified Android release certificate SHA-256: {expected}')
PY
[ "$("$tools/aapt" dump badging "$work/signed.apk")" = "$badging" ] || {
  echo 'Signed APK package metadata changed' >&2
  exit 1
}
"$tools/zipalign" -c -P 16 4 "$work/signed.apk"
# Publish only a fully verified APK; preserve any caller-owned output.
ln "$work/signed.apk" "$output"
echo "Signed Android APK: $output"
