#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
for name in RUNNER_TEMP IOS_VERSION IOS_BUILD_NUMBER IOS_APP_ID \
  IOS_DISTRIBUTION_P12_BASE64 IOS_DISTRIBUTION_P12_PASSWORD IOS_PROVISIONING_PROFILE_BASE64 \
  APP_STORE_CONNECT_API_KEY_BASE64 APP_STORE_CONNECT_API_KEY_ID APP_STORE_CONNECT_API_ISSUER_ID; do
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
[[ "$APP_STORE_CONNECT_API_KEY_ID" =~ ^[A-Za-z0-9]+$ ]] || exit 1

umask 077
work=$(mktemp -d "$RUNNER_TEMP/okou-ios-release.XXXXXX")
keychain="$work/signing.keychain-db"
profile_path=""
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  if [ -n "$profile_path" ]; then rm -f "$profile_path"; fi
  rm -rf "$work"
}
trap cleanup EXIT
printf '%s' "$IOS_DISTRIBUTION_P12_BASE64" | base64 -D > "$work/distribution.p12"
printf '%s' "$IOS_PROVISIONING_PROFILE_BASE64" | base64 -D > "$work/profile.mobileprovision"
security cms -D -i "$work/profile.mobileprovision" > "$work/profile.plist"
profile_uuid=$(/usr/libexec/PlistBuddy -c 'Print UUID' "$work/profile.plist")
# Verify distribution scope before installing the profile or contacting Apple.
python3 - "$work/profile.plist" <<'PY'
import datetime, plistlib, sys, uuid
with open(sys.argv[1], 'rb') as f:
    profile = plistlib.load(f)
uuid.UUID(profile['UUID'])
if profile['TeamIdentifier'] != ['C5UWSXYB67']: raise ValueError('Wrong signing team')
if profile['Entitlements']['application-identifier'] != 'C5UWSXYB67.ai.okou.ios': raise ValueError('Wrong bundle ID')
if profile['Entitlements'].get('get-task-allow'): raise ValueError('Development profile is not a distribution profile')
if profile.get('ProvisionedDevices') or profile.get('ProvisionsAllDevices'): raise ValueError('An App Store Connect distribution profile is required')
if profile['ExpirationDate'] <= datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None): raise ValueError('Expired provisioning profile')
PY
profiles="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
mkdir -p "$profiles"
profile_path="$profiles/$profile_uuid.mobileprovision"
# Hosted runners are ephemeral. Never replace an existing user's profile locally.
if [ -e "$profile_path" ]; then
  profile_path=""
  echo 'Provisioning profile already exists; use a clean CI runner' >&2
  exit 1
fi
cp "$work/profile.mobileprovision" "$profile_path"
keychain_password=$(openssl rand -hex 32)
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$work/distribution.p12" -k "$keychain" -P "$IOS_DISTRIBUTION_P12_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
security list-keychains -d user -s "$keychain" "$HOME/Library/Keychains/login.keychain-db"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null
identity=$(security find-identity -v -p codesigning "$keychain" | sed -n 's/.*) \([A-F0-9]*\) "Apple Distribution:.*"/\1/p')
[[ "$identity" =~ ^[A-F0-9]{40}$ ]] || { echo 'Expected one valid Apple Distribution identity' >&2; exit 1; }

resolved=ios/Okou.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved
cp "$resolved" "$work/Package.resolved"
xcode_args=(
  -project ios/Okou.xcodeproj -scheme Okou -configuration Release
  -destination 'generic/platform=iOS' -derivedDataPath "$work/DerivedData"
  -clonedSourcePackagesDirPath "$work/SourcePackages"
  -onlyUsePackageVersionsFromResolvedFile -disableAutomaticPackageResolution -skipPackageUpdates
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=C5UWSXYB67
  CODE_SIGN_IDENTITY="$identity" PROVISIONING_PROFILE_SPECIFIER="$profile_uuid"
  OTHER_CODE_SIGN_FLAGS="--keychain $keychain"
  MARKETING_VERSION="$IOS_VERSION" CURRENT_PROJECT_VERSION="$IOS_BUILD_NUMBER"
)
xcodebuild "${xcode_args[@]}" -resolvePackageDependencies
cmp "$resolved" "$work/Package.resolved"
xcodebuild "${xcode_args[@]}" -archivePath "$work/Okou.xcarchive" archive
cmp "$resolved" "$work/Package.resolved"
python3 - "$work/ExportOptions.plist" "$profile_uuid" "$identity" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'wb') as f:
    plistlib.dump({
        'method': 'app-store-connect', 'destination': 'export',
        'signingStyle': 'manual', 'teamID': 'C5UWSXYB67',
        'signingCertificate': sys.argv[3],
        'provisioningProfiles': {'ai.okou.ios': sys.argv[2]},
        'manageAppVersionAndBuildNumber': False,
        'testFlightInternalTestingOnly': True,
        'uploadSymbols': True,
    }, f)
PY
xcodebuild -exportArchive -archivePath "$work/Okou.xcarchive" \
  -exportOptionsPlist "$work/ExportOptions.plist" -exportPath "$work/export"
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
