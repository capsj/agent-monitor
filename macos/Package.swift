// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AgentMonitorMenuBar",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "AgentMonitorMenuBar", targets: ["AgentMonitorMenuBar"]),
    ],
    targets: [
        .executableTarget(
            name: "AgentMonitorMenuBar",
            path: "Sources/AgentMonitorMenuBar"
        ),
    ],
    swiftLanguageModes: [.v5]
)
