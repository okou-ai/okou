#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${IOS_TEST_DESTINATION:?IOS_TEST_DESTINATION is required}"

build_root="$RUNNER_TEMP/okou-ios-ci"
mkdir -p "$build_root"
resolved=ios/Okou.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved
# CI overlaps simulator startup with dependency resolution, then compiles and runs.
# Prepare/compile/run phases belong to CI; build retains the combined build entry.
# Package CI has its own runner.
# With no phase argument, supported manual callers still run every suite.
ios_test_phase=${1:-all}
case "$ios_test_phase" in
  all | build | prepare | compile | run) ;;
  *) echo "usage: ci-test.sh [all|build|prepare|compile|run]" >&2; exit 2 ;;
esac

xcode_args=(
  -project ios/Okou.xcodeproj
  -scheme Okou
  -configuration Debug
  -destination "$IOS_TEST_DESTINATION"
  -derivedDataPath "$build_root/DerivedData"
  -clonedSourcePackagesDirPath "$build_root/SourcePackages"
  -scmProvider system
  -onlyUsePackageVersionsFromResolvedFile
  -disableAutomaticPackageResolution
  -disablePackageRepositoryCache
  -skipPackageUpdates
  # IDE source indexing is unnecessary for CI test products.
  COMPILER_INDEX_STORE_ENABLE=NO
  CODE_SIGN_IDENTITY=-
  CODE_SIGNING_ALLOWED=YES
  DEVELOPMENT_TEAM=
  # Tests use URLProtocol or loopback HTTP; even an accidental normal launch has no service config.
  OKOU_API_BASE_URL=https://api.example.invalid
  OKOU_WEB_BASE_URL=https://app.example.invalid
  CLERK_PUBLISHABLE_KEY=
)

# Keep warm producers and simulator consumers on the same official cache settings.
if [[ "${IOS_BUILD_CACHE_ENABLED:-false}" == true ]]; then
  xcode_args+=(
    COMPILATION_CACHE_ENABLE_CACHING=YES
    COMPILATION_CACHE_ENABLE_DIAGNOSTIC_REMARKS=YES
  )
fi

if [[ "$ios_test_phase" == all ]]; then
  bash ios/scripts/ci-package-test.sh
fi

if [[ "$ios_test_phase" == all || "$ios_test_phase" == build || "$ios_test_phase" == prepare ]]; then
  ios_phase_started=$SECONDS
  cp "$resolved" "$build_root/Package.resolved.before"
  if [[ -n "${IOS_PACKAGE_SOURCES_DIR:-}" ]]; then
    python3 ios/scripts/prepare-package-sources.py "$resolved" "$build_root" "$IOS_PACKAGE_SOURCES_DIR"
  else
    python3 ios/scripts/prepare-package-sources.py "$resolved" "$build_root"
  fi
fi

# Keep the caller's Git configuration and add only this job's locked sources.
git_config_index=${GIT_CONFIG_COUNT:-0}
export "GIT_CONFIG_KEY_${git_config_index}=include.path"
export "GIT_CONFIG_VALUE_${git_config_index}=$build_root/package-sources.gitconfig"
export GIT_CONFIG_COUNT=$((git_config_index + 1))

if [[ "$ios_test_phase" == all || "$ios_test_phase" == build || "$ios_test_phase" == prepare ]]; then
  xcodebuild "${xcode_args[@]}" -resolvePackageDependencies
  cmp "$resolved" "$build_root/Package.resolved.before"
  for repository in "$build_root"/SourcePackages/repositories/*; do
    printf 'Resolved package repository %s shallow: ' "${repository##*/}"
    git --git-dir="$repository" rev-parse --is-shallow-repository
    printf 'Resolved package repository %s commits: ' "${repository##*/}"
    git --git-dir="$repository" rev-list --count --all
  done
  echo "iOS dependency preparation: $((SECONDS - ios_phase_started)) seconds"
fi

if [[ "$ios_test_phase" == all || "$ios_test_phase" == build || "$ios_test_phase" == compile ]]; then
  ios_phase_started=$SECONDS
  cmp "$resolved" "$build_root/Package.resolved.before"
  xcodebuild "${xcode_args[@]}" -showBuildTimingSummary build-for-testing
  cmp "$resolved" "$build_root/Package.resolved.before"
  echo "iOS build-for-testing: $((SECONDS - ios_phase_started)) seconds"
fi

if [[ "$ios_test_phase" == all || "$ios_test_phase" == run ]]; then
  ios_phase_started=$SECONDS
  cmp "$resolved" "$build_root/Package.resolved.before"
  # Use the build's test specification without loading the package graph again.
  test_runs=("$build_root"/DerivedData/Build/Products/*.xctestrun)
  if [[ ${#test_runs[@]} -ne 1 ]]; then
    echo "Expected exactly one built test specification, found ${#test_runs[@]}" >&2
    exit 1
  fi
  # Keep test results and attachments without failure-triggered simulator sysdiagnoses.
  xcodebuild -xctestrun "${test_runs[0]}" \
    -destination "$IOS_TEST_DESTINATION" \
    -parallel-testing-enabled NO \
    -maximum-concurrent-test-simulator-destinations 1 \
    -collect-test-diagnostics never \
    -resultBundlePath "$build_root/Tests.xcresult" \
    test-without-building
  cmp "$resolved" "$build_root/Package.resolved.before"
  echo "iOS test-without-building: $((SECONDS - ios_phase_started)) seconds"
fi
