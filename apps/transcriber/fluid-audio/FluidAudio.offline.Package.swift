// swift-tools-version: 6.2
// Build-only manifest for the pinned FluidAudio 0.17.7 source, not an SDK fork.
// The production helper uses no TTS; omit the unused NeMo binary artifact so
// SwiftPM cannot download it while resolving a local dependency in a Nix build.
import PackageDescription
let package = Package(
    name: "FluidAudio",
    platforms: [.macOS(.v14)],
    products: [.library(name: "FluidAudio", targets: ["FluidAudio"])],
    targets: [
        .target(name: "FluidAudio", dependencies: ["FastClusterWrapper", "MachTaskSelfWrapper"],
                path: "Sources/FluidAudio", exclude: ["ASR/Parakeet/Unified/benchmark.md"],
                resources: [.process("TTS/LuxTts/G2p/Resources")]),
        .target(name: "FastClusterWrapper", path: "Sources/FastClusterWrapper", publicHeadersPath: "include"),
        .target(name: "MachTaskSelfWrapper", path: "Sources/MachTaskSelfWrapper", publicHeadersPath: "include")
    ],
    cxxLanguageStandard: .cxx17
)
