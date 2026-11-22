#!/usr/bin/env bash
# Transfer the complete Xcode test products between the two existing native runners.
set -euo pipefail

root="${RUNNER_TEMP:?}/okou-ios-ci"
transfer="$RUNNER_TEMP/ios-native-products"
lock=ios/Okou.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved
identity() {
  printf '%s\n' "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}" "${GITHUB_SHA:?}" "${ImageOS:-unknown}" "${ImageVersion:-unknown}"
  sw_vers -buildVersion
  uname -m
}

case "${1:-}" in
  pack)
    mkdir -p "$transfer"
    cmp "$lock" "$root/Package.resolved.before"
    identity > "$transfer/product-identity"
    cp "${IOS_PRODUCT_TOOLCHAIN:?}" "$transfer/product-toolchain.json"
    cp "$root/Package.resolved.before" "$transfer/"
    # Preserve all products, links, permissions, and symbols in one compressed stream.
    tar -cf - -C "$root" DerivedData/Build/Products |
      zstd -q --single-thread -5 --long=28 -o "$transfer/products.tar.zst"
    du -h "$transfer/products.tar.zst"
    ;;
  unpack)
    mkdir -p "$root"
    # Verify provenance and the resolved lock before installing any executable products.
    cmp "$transfer/product-identity" <(identity)
    cmp "$transfer/product-toolchain.json" "${IOS_PRODUCT_TOOLCHAIN:?}"
    cmp "$transfer/Package.resolved.before" "$lock"
    zstd -qdc --long=28 "$transfer/products.tar.zst" | tar -xf - -C "$root"
    cp "$transfer/Package.resolved.before" "$root/"
    ;;
  *)
    echo "usage: transfer-ci-test-products.sh pack|unpack" >&2
    exit 2
    ;;
esac
