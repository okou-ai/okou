#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
: "${IOS_ARCHIVE_DIR:?IOS_ARCHIVE_DIR is required}"
if [ -e ios/Config/Local.xcconfig ]; then
  echo 'Remove ios/Config/Local.xcconfig before a release archive' >&2
  exit 1
fi
work="$IOS_ARCHIVE_DIR"
mkdir -p "$work"
version=$(<ios/version.txt)
resolved=ios/Okou.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved
cp "$resolved" "$work/Package.resolved.before"
xcode_args=(
  -project ios/Okou.xcodeproj -scheme Okou -configuration Release
  -destination 'generic/platform=iOS' -derivedDataPath "$work/DerivedData"
  -clonedSourcePackagesDirPath "$work/SourcePackages"
  -onlyUsePackageVersionsFromResolvedFile -disableAutomaticPackageResolution -skipPackageUpdates
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= DEVELOPMENT_TEAM=
  MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION=1
)
xcodebuild -version
xcodebuild "${xcode_args[@]}" -resolvePackageDependencies
cmp "$resolved" "$work/Package.resolved.before"
xcodebuild "${xcode_args[@]}" -archivePath "$work/Original.xcarchive" -showBuildTimingSummary archive
cmp "$resolved" "$work/Package.resolved.before"
python3 ios/scripts/archive-proof.py validate "$work/Original.xcarchive" --version "$version"
tar -czf "$work/archive.tar.gz" -C "$work" Original.xcarchive
python3 - "$work" <<'PY'
import hashlib, pathlib, sys
work = pathlib.Path(sys.argv[1])
with (work / 'archive.tar.gz').open('rb') as archive:
    checksum = hashlib.file_digest(archive, 'sha256').hexdigest()
(work / 'archive-sha256.txt').write_text(checksum + '\n')
PY
