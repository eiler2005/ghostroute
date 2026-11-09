// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GhostRouteGuard",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "GhostRouteGuard", targets: ["GuardApp"]),
               .executable(name: "GuardNativeChecks", targets: ["GuardNativeChecks"])],
    targets: [
        .target(name: "GuardCore"),
        .target(name: "GuardUI", dependencies: ["GuardCore"]),
        .executableTarget(name: "GuardApp", dependencies: ["GuardCore", "GuardUI"]),
        .executableTarget(name: "GuardNativeChecks", dependencies: ["GuardCore", "GuardUI"], path: "Checks")
    ]
)
