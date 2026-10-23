// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "UomiFluidSegments",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "uomi-fluid-segments", targets: ["UomiFluidSegments"])],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git",
                 revision: "503b4bd1bbf7220882de39fe8ae6716aae4132da", traits: [])
    ],
    targets: [
        .executableTarget(name: "UomiFluidSegments", dependencies: [.product(name: "FluidAudio", package: "FluidAudio")])
    ]
)
