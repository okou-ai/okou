// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "ChatData",
  platforms: [.iOS("26.0"), .macOS(.v15)],
  products: [
    .library(name: "ChatData", targets: ["ChatData"]),
    .library(name: "ChatDataTestSupport", targets: ["ChatDataTestSupport"]),
  ],
  dependencies: [.package(path: "../ChatDomain")],
  targets: [
    .target(name: "ChatData", dependencies: [.product(name: "ChatDomain", package: "ChatDomain")]),
    .target(name: "ChatDataTestSupport", dependencies: ["ChatData"]),
    .testTarget(name: "ChatDataTests", dependencies: ["ChatData", "ChatDataTestSupport"]),
  ],
  swiftLanguageModes: [.v6]
)
