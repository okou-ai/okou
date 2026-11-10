#!/usr/bin/env bash
# Build a non-publishing, unsigned staging device IPA for BrowserStack.
# Requires Xcode, IOS_ARCHIVE_DIR, and the public CLERK_PUBLISHABLE_KEY_PREVIEW
# repository variable in OKOU_STAGING_CLERK_PUBLISHABLE_KEY. Outputs are private
# Actions artifacts; no signing credentials or preview bypass values are used.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
: "${IOS_ARCHIVE_DIR:?IOS_ARCHIVE_DIR is required}"
: "${OKOU_STAGING_CLERK_PUBLISHABLE_KEY:?CLERK_PUBLISHABLE_KEY_PREVIEW is required}"
case "$OKOU_STAGING_CLERK_PUBLISHABLE_KEY" in
  pk_test_*) ;;
  *) echo 'Staging requires a Clerk TEST publishable key.' >&2; exit 1 ;;
esac
if [[ -e ios/Config/Local.xcconfig ]]; then
  echo 'Remove ios/Config/Local.xcconfig before a staging archive.' >&2
  exit 1
fi

work="$IOS_ARCHIVE_DIR"
mkdir -p "$work/preview"
version=$(<ios/version.txt)
resolved=ios/Okou.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved
cp "$resolved" "$work/Package.resolved.before"
xcode_args=(
  -project ios/Okou.xcodeproj -scheme Okou -configuration Release
  -xcconfig ios/Config/Staging.xcconfig -destination 'generic/platform=iOS'
  -derivedDataPath "$work/DerivedData" -clonedSourcePackagesDirPath "$work/SourcePackages"
  -onlyUsePackageVersionsFromResolvedFile -disableAutomaticPackageResolution -skipPackageUpdates
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= DEVELOPMENT_TEAM=
  MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION=1
  OKOU_STAGING_CLERK_PUBLISHABLE_KEY="$OKOU_STAGING_CLERK_PUBLISHABLE_KEY"
  COMPILATION_CACHE_ENABLE_CACHING=YES COMPILATION_CACHE_ENABLE_DIAGNOSTIC_REMARKS=YES
)
xcodebuild -version
xcodebuild "${xcode_args[@]}" -resolvePackageDependencies
cmp "$resolved" "$work/Package.resolved.before"
xcodebuild "${xcode_args[@]}" -archivePath "$work/Staging.xcarchive" -showBuildTimingSummary archive
cmp "$resolved" "$work/Package.resolved.before"
python3 ios/scripts/preview-artifact.py "$work/Staging.xcarchive" "$work/preview" --version "$version"
