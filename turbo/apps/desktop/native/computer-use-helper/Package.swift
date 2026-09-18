// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "ComputerUseHelper",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(
            name: "computer-use-helper",
            targets: ["ComputerUseHelper"]
        ),
    ],
    dependencies: [
        .package(url: "https://github.com/getsentry/sentry-cocoa.git", from: "9.6.0")
    ],
    targets: [
        .target(
            name: "ComputerUseHelperCore"
        ),
        .executableTarget(
            name: "ComputerUseHelper",
            dependencies: [
                "ComputerUseHelperCore",
                .product(name: "Sentry", package: "sentry-cocoa"),
            ]
        ),
        .testTarget(
            name: "ComputerUseHelperIntegrationTests",
            dependencies: ["ComputerUseHelper"]
        ),
        .testTarget(
            name: "ComputerUseHelperCoreTests",
            dependencies: ["ComputerUseHelperCore"]
        ),
    ]
)
