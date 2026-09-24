// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "ClerkAuthHelper",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "clerk-auth-helper", targets: ["ClerkAuthHelper"])],
    dependencies: [
        .package(url: "https://github.com/clerk/clerk-ios.git", exact: "1.5.6"),
    ],
    targets: [
        .executableTarget(
            name: "ClerkAuthHelper",
            dependencies: [.product(name: "ClerkKit", package: "clerk-ios")]
        ),
    ]
)
