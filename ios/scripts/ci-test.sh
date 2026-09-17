#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${IOS_TEST_DESTINATION:?IOS_TEST_DESTINATION is required}"

build_root="$RUNNER_TEMP/okou-ios-ci"
mkdir -p "$build_root"
resolved=ios/Okou.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved
cp "$resolved" "$build_root/Package.resolved.before"

xcode_args=(
  -project ios/Okou.xcodeproj
  -scheme Okou
  -configuration Debug
  -destination "$IOS_TEST_DESTINATION"
  -derivedDataPath "$build_root/DerivedData"
  -clonedSourcePackagesDirPath "$build_root/SourcePackages"
  -onlyUsePackageVersionsFromResolvedFile
  -disableAutomaticPackageResolution
  -skipPackageUpdates
  CODE_SIGN_IDENTITY=-
  CODE_SIGNING_ALLOWED=YES
  DEVELOPMENT_TEAM=
  # Tests use URLProtocol or loopback HTTP; even an accidental normal launch has no service config.
  OKOU_API_BASE_URL=https://api.example.invalid
  OKOU_WEB_BASE_URL=https://app.example.invalid
  CLERK_PUBLISHABLE_KEY=
)

xcodebuild "${xcode_args[@]}" -resolvePackageDependencies
cmp "$resolved" "$build_root/Package.resolved.before"

xcodebuild "${xcode_args[@]}" \
  -parallel-testing-enabled NO \
  -maximum-concurrent-test-simulator-destinations 1 \
  -resultBundlePath "$build_root/Tests.xcresult" \
  test

cmp "$resolved" "$build_root/Package.resolved.before"
