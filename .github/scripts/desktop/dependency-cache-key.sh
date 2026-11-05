#!/usr/bin/env bash
set -euo pipefail

# Capture each native tool separately: a failed tool must never publish a key.
os_version=$(sw_vers -productVersion)
architecture=$(uname -m)
xcode=$(xcodebuild -version)
swift=$(xcrun swift --version)
sdk=$(xcrun --sdk macosx --show-sdk-version)
toolchain=$(printf '%s\0' "$os_version" "$architecture" "$xcode" "$swift" "$sdk" | shasum -a 256 | cut -d ' ' -f 1)
locks=$(shasum -a 256 \
  desktop/Package.resolved \
  desktop/ComputerUse/Package.resolved \
  desktop/Okou.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved | shasum -a 256 | cut -d ' ' -f 1)
printf 'key=desktop-swiftpm-downloads-v1-%s-%s\n' "$toolchain" "$locks"
