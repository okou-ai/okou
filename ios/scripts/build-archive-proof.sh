#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
if [ -e ios/Config/Local.xcconfig ]; then
  echo 'Remove ios/Config/Local.xcconfig before a release archive' >&2
  exit 1
fi
work="$RUNNER_TEMP/okou-ios-archive-proof"
mkdir "$work"
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
# Xcode is not invoked after this point. Preparation must leave compiled files and symbols intact.
python3 ios/scripts/archive-proof.py prepare "$work/Original.xcarchive" "$work/Prepared.xcarchive" \
  --version "$version" --build-number 9999
tar -czf "$work/archive.tar.gz" -C "$work" Original.xcarchive
python3 - "$work" <<'PY'
import hashlib, json, pathlib, subprocess, sys
work = pathlib.Path(sys.argv[1])
manifest = {
    'version': 1,
    'commitSha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
    'archiveSha256': hashlib.sha256((work / 'archive.tar.gz').read_bytes()).hexdigest(),
    'purpose': 'archive-promotion-proof-only',
}
(work / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
PY
