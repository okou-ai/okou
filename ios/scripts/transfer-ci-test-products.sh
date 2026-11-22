#!/usr/bin/env bash
# Transfer the complete Xcode test products between the two existing native runners.
set -euo pipefail

root="${RUNNER_TEMP:?}/okou-ios-ci"
transfer="$RUNNER_TEMP/ios-native-products"
lock=ios/Okou.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved
identity() {
  printf '%s\n' "${GITHUB_RUN_ID:?}" "${GITHUB_SHA:?}" "${ImageOS:-unknown}" "${ImageVersion:-unknown}"
  sw_vers -buildVersion
  uname -m
}

case "${1:-}" in
  pack)
    mkdir -p "$transfer"
    cmp "$lock" "$root/Package.resolved.before"
    identity > "$transfer/product-identity"
    cp "${IOS_PRODUCT_TOOLCHAIN:?}" "$transfer/product-toolchain.json"
    cp "$root/Package.resolved.before" "$root/package-sources.gitconfig" "$transfer/"
    tar -cf "$transfer/products.tar" -C "$root" DerivedData/Build/Products
    du -h "$transfer/products.tar"
    ;;
  unpack)
    mkdir -p "$root"
    # Verify provenance and the resolved lock before installing any executable products.
    cmp "$transfer/product-identity" <(identity)
    cmp "$transfer/product-toolchain.json" "${IOS_PRODUCT_TOOLCHAIN:?}"
    cmp "$transfer/Package.resolved.before" "$lock"
    tar -xf "$transfer/products.tar" -C "$root"
    cp "$transfer/Package.resolved.before" "$transfer/package-sources.gitconfig" "$root/"
    ;;
  *)
    echo "usage: transfer-ci-test-products.sh pack|unpack" >&2
    exit 2
    ;;
esac
