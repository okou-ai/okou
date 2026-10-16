// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "OkouDesktop",
  platforms: [.macOS(.v14)],
  products: [.library(name: "OkouCore", targets: ["OkouCore"])],
  targets: [
    .target(name: "ShellProcess", path: "ShellProcess", publicHeadersPath: "include"),
    .target(name: "OkouCore", dependencies: ["ShellProcess"], path: "Okou/Core"),
    .testTarget(name: "OkouCoreTests", dependencies: ["OkouCore"]),
  ],
  swiftLanguageModes: [.v6]
)
