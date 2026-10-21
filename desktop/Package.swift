// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "OkouDesktop",
  platforms: [.macOS(.v14)],
  products: [.library(name: "OkouCore", targets: ["OkouCore"])],
  dependencies: [
    .package(url: "https://github.com/getsentry/sentry-cocoa.git", exact: "9.17.1")
  ],
  targets: [
    .target(name: "ShellProcess", path: "ShellProcess", publicHeadersPath: "include"),
    .target(
      name: "OkouCore",
      dependencies: ["ShellProcess", .product(name: "Sentry", package: "sentry-cocoa")],
      path: "Okou/Core"),
    .testTarget(
      name: "OkouCoreTests",
      dependencies: ["OkouCore", .product(name: "Sentry", package: "sentry-cocoa")]),
  ],
  swiftLanguageModes: [.v6]
)
