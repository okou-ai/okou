#!/usr/bin/env bash
# Run standalone package formatting/tests with Xcode's Swift toolchain.
# Requires RUNNER_TEMP; writes isolated scratch builds and propagates failures.
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
build_root="$RUNNER_TEMP/okou-ios-ci"
mkdir -p "$build_root"

# Core/data tests use real decoding, HTTP and SQLite without booting the App.
for ios_package in ChatDomain ChatData; do
  ios_package_path="ios/Packages/$ios_package"
  xcrun swift-format lint --strict --recursive "$ios_package_path/Package.swift" \
    "$ios_package_path/Sources" "$ios_package_path/Tests"
  swift test --package-path "$ios_package_path" --scratch-path "$build_root/$ios_package"
done
