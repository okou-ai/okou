#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
if (( $# != 2 )) || [[ "$1" != --archive && "$1" != --verify-archive ]] || [ -z "$2" ]; then
  echo 'usage: release-testflight.sh (--archive|--verify-archive) <unsigned.xcarchive>' >&2
  exit 1
fi
archive=$2
proof=false
if [ "$1" = --verify-archive ]; then proof=true; fi
required=(RUNNER_TEMP IOS_VERSION IOS_BUILD_NUMBER
  IOS_DISTRIBUTION_P12_BASE64 IOS_DISTRIBUTION_P12_PASSWORD IOS_PROVISIONING_PROFILE_BASE64
  IOS_NOTIFICATION_EXTENSION_PROFILE_BASE64)
if [ "$proof" = false ]; then
  required+=(IOS_APP_ID APP_STORE_CONNECT_API_KEY_BASE64 APP_STORE_CONNECT_API_KEY_ID APP_STORE_CONNECT_API_ISSUER_ID)
fi
for name in "${required[@]}"; do
  if [ -z "${!name:-}" ]; then
    echo "${name} is required for iOS distribution" >&2
    exit 1
  fi
done
if [ "$(cat ios/version.txt)" != "$IOS_VERSION" ]; then
  echo 'Release version does not match the checked-out iOS source' >&2
  exit 1
fi
# Local-only overrides must never enter a production archive.
if [ -e ios/Config/Local.xcconfig ]; then
  echo 'Remove ios/Config/Local.xcconfig before a release build' >&2
  exit 1
fi
[[ "$IOS_BUILD_NUMBER" =~ ^[1-9][0-9]{0,3}$ ]] || exit 1
if [ "$proof" = false ]; then
  [[ "$APP_STORE_CONNECT_API_KEY_ID" =~ ^[A-Za-z0-9]+$ ]] || exit 1
fi

umask 077
work=$(mktemp -d "$RUNNER_TEMP/okou-ios-release.XXXXXX")
keychain="$work/signing.keychain-db"
profile_paths=()
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  for profile_path in "${profile_paths[@]}"; do rm -f "$profile_path"; done
  rm -rf "$work"
}
trap cleanup EXIT
# Validate and prepare before opening the signing keychain. Never compile here.
python3 ios/scripts/archive-proof.py prepare "$archive" "$work/Okou.xcarchive" \
  --version "$IOS_VERSION" --build-number "$IOS_BUILD_NUMBER"
printf '%s' "$IOS_DISTRIBUTION_P12_BASE64" | base64 -D > "$work/distribution.p12"
profiles="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
mkdir -p "$profiles"
# Validate both identities and shared capabilities before installing profiles or signing.
for bundle in app extension; do
  if [ "$bundle" = app ]; then
    encoded_profile=$IOS_PROVISIONING_PROFILE_BASE64
    bundle_id=ai.okou.ios
  else
    encoded_profile=$IOS_NOTIFICATION_EXTENSION_PROFILE_BASE64
    bundle_id=ai.okou.ios.notifications
  fi
  printf '%s' "$encoded_profile" | base64 -D > "$work/$bundle.mobileprovision"
  security cms -D -i "$work/$bundle.mobileprovision" > "$work/$bundle-profile.plist"
  profile_uuid=$(python3 ios/scripts/distribution-profile.py "$work/$bundle-profile.plist" \
    "$work/$bundle-entitlements.plist" --bundle-id "$bundle_id")
  if [ "$bundle" = app ]; then app_profile_uuid=$profile_uuid; else extension_profile_uuid=$profile_uuid; fi
  profile_path="$profiles/$profile_uuid.mobileprovision"
  # Hosted runners are ephemeral. Never replace an existing user's profile locally.
  if [ -e "$profile_path" ]; then
    echo 'Provisioning profile already exists; use a clean CI runner' >&2
    exit 1
  fi
  cp "$work/$bundle.mobileprovision" "$profile_path"
  profile_paths+=("$profile_path")
done
unset encoded_profile
keychain_password=$(openssl rand -hex 32)
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$work/distribution.p12" -k "$keychain" -P "$IOS_DISTRIBUTION_P12_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
security list-keychains -d user -s "$keychain" "$HOME/Library/Keychains/login.keychain-db"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null
identity=$(security find-identity -v -p codesigning "$keychain" | sed -n 's/.*) \([A-F0-9]*\) "Apple Distribution:.*"/\1/p')
[[ "$identity" =~ ^[A-F0-9]{40}$ ]] || { echo 'Expected one valid Apple Distribution identity' >&2; exit 1; }

# An unsigned archive has no signature from which export can recover app capabilities.
# Sign only the prepared copy so export retains the source-declared APNs entitlement.
app="$work/Okou.xcarchive/Products/Applications/Okou.app"
extension="$app/PlugIns/OkouNotificationService.appex"
cp "$work/extension.mobileprovision" "$extension/embedded.mobileprovision"
codesign --force --sign "$identity" --keychain "$keychain" --generate-entitlement-der \
  --entitlements "$work/extension-entitlements.plist" "$extension"
cp "$work/app.mobileprovision" "$app/embedded.mobileprovision"
codesign --force --sign "$identity" --keychain "$keychain" --generate-entitlement-der \
  --entitlements "$work/app-entitlements.plist" "$app"

python3 - "$work/ExportOptions.plist" "$app_profile_uuid" "$extension_profile_uuid" "$identity" <<'PYEXPORT'
import plistlib, sys
with open(sys.argv[1], 'wb') as f:
    plistlib.dump({
        'method': 'app-store-connect', 'destination': 'export',
        'signingStyle': 'manual', 'teamID': 'C5UWSXYB67',
        'signingCertificate': sys.argv[4],
        'provisioningProfiles': {'ai.okou.ios': sys.argv[2], 'ai.okou.ios.notifications': sys.argv[3]},
        'manageAppVersionAndBuildNumber': False,
        'testFlightInternalTestingOnly': True,
        'uploadSymbols': True,
    }, f)
PYEXPORT
xcodebuild -exportArchive -archivePath "$work/Okou.xcarchive" \
  -exportOptionsPlist "$work/ExportOptions.plist" -exportPath "$work/export"
python3 ios/scripts/archive-proof.py verify-export "$archive" "$work/export/Okou.ipa" \
  --version "$IOS_VERSION" --build-number "$IOS_BUILD_NUMBER"
mkdir "$work/unpacked"
ditto -x -k "$work/export/Okou.ipa" "$work/unpacked"
codesign --verify --deep --strict "$work/unpacked/Payload/Okou.app"
for bundle_id in ai.okou.ios ai.okou.ios.notifications; do
  signed_bundle="$work/unpacked/Payload/Okou.app"
  if [ "$bundle_id" = ai.okou.ios.notifications ]; then
    signed_bundle="$signed_bundle/PlugIns/OkouNotificationService.appex"
  fi
  codesign --display --entitlements - --xml "$signed_bundle" > "$work/entitlements.plist" 2>/dev/null
  python3 - "$work/entitlements.plist" "$bundle_id" <<'PYVERIFY'
import plistlib, sys
with open(sys.argv[1], 'rb') as file:
    entitlements = plistlib.load(file)
if entitlements['application-identifier'] != 'C5UWSXYB67.' + sys.argv[2]:
    raise ValueError('Exported bundle has the wrong application entitlement')
if entitlements['com.apple.developer.team-identifier'] != 'C5UWSXYB67':
    raise ValueError('Exported bundle has the wrong signing team')
if sys.argv[2] == 'ai.okou.ios' and entitlements.get('aps-environment') != 'production':
    raise ValueError('Exported app must have production APNs')
if entitlements.get('com.apple.security.application-groups') != ['group.ai.okou.ios']:
    raise ValueError('Exported bundle must share the Okou cache App Group')
if entitlements.get('keychain-access-groups') != ['C5UWSXYB67.ai.okou.ios']:
    raise ValueError('Exported bundle must share the existing Okou Keychain group')
if entitlements.get('get-task-allow'):
    raise ValueError('Exported bundle is development-signed')
PYVERIFY
done
if [ "$proof" = true ]; then
  echo 'Archive promotion proof passed: distribution export, build number, compiled sections, and signature verified; nothing uploaded.'
  exit 0
fi

# Retain symbols for the exact released build, without signing credentials.
mkdir -p "$RUNNER_TEMP/okou-ios-symbols"
cp -R "$work/Okou.xcarchive/dSYMs" "$RUNNER_TEMP/okou-ios-symbols/"

export API_PRIVATE_KEYS_DIR="$work/keys"
mkdir -p "$API_PRIVATE_KEYS_DIR"
printf '%s' "$APP_STORE_CONNECT_API_KEY_BASE64" | base64 -D > "$API_PRIVATE_KEYS_DIR/AuthKey_$APP_STORE_CONNECT_API_KEY_ID.p8"
xcrun altool --upload-package "$work/export/Okou.ipa" --platform ios \
  --apple-id "$IOS_APP_ID" --bundle-id ai.okou.ios \
  --bundle-version "$IOS_BUILD_NUMBER" --bundle-short-version-string "$IOS_VERSION" \
  --api-key "$APP_STORE_CONNECT_API_KEY_ID" --api-issuer "$APP_STORE_CONNECT_API_ISSUER_ID"
