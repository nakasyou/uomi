{ lib, stdenvNoCC, fetchFromGitHub, fetchurl, makeWrapper, uomiSrc }:
let
  fluidAudio = fetchFromGitHub {
    owner = "FluidInference";
    repo = "FluidAudio";
    rev = "503b4bd1bbf7220882de39fe8ae6716aae4132da";
    sha256 = "09w5ii65nwhd1yy9mxl3738kgbmiksj97d57ydmdnrwmyb3ysg5c";
  };
  modelFiles = builtins.fromJSON (builtins.readFile "${uomiSrc}/apps/transcriber/fluid-audio/models.lock.json");
  models = stdenvNoCC.mkDerivation {
    name = "uomi-fluid-models-v1";
    dontUnpack = true;
    installPhase = lib.concatMapStringsSep "\n" (file:
      let artifact = fetchurl { inherit (file) url sha256; }; in
      "install -Dm444 ${artifact} $out/${file.path}"
    ) modelFiles.files;
  };
in stdenvNoCC.mkDerivation {
  pname = "uomi-fluid-segments";
  version = "1.0.0-fluid-0.17.7";
  src = "${uomiSrc}/apps/transcriber/fluid-audio";
  nativeBuildInputs = [ makeWrapper ];
  # Apple CoreML requires the installed Apple toolchain. Check its exact version;
  # dependency source + CoreML models remain immutable Nix inputs, no SwiftPM network.
  buildPhase = ''
    runHook preBuild
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"
    export DEVELOPER_DIR=/Library/Developer/CommandLineTools
    export SDKROOT=$(/usr/bin/xcrun --sdk macosx --show-sdk-path)
    /usr/bin/swift --version | /usr/bin/grep -F "Apple Swift version 6.2.4 (swiftlang-6.2.4.1.4"
    cp -R ${fluidAudio} "$TMPDIR/FluidAudio"
    chmod -R u+w "$TMPDIR/FluidAudio"
    rm -f "$TMPDIR/FluidAudio/Package@swift-6.2.swift"
    cp FluidAudio.offline.Package.swift "$TMPDIR/FluidAudio/Package.swift"
    substituteInPlace Package.swift --replace-fail \
      '.package(url: "https://github.com/FluidInference/FluidAudio.git",' \
      '.package(path: "'"$TMPDIR"'/FluidAudio",'
    substituteInPlace Package.swift --replace-fail \
      'revision: "503b4bd1bbf7220882de39fe8ae6716aae4132da", traits: [])' \
      ')'
    rm -f Package.resolved
    /usr/bin/swiftc Sources/UomiFluidSegments/Plan.swift Tests/main.swift -o "$TMPDIR/plan-tests"
    "$TMPDIR/plan-tests"
    /usr/bin/swift build --disable-sandbox --configuration release --scratch-path "$TMPDIR/swift-build" \
      --cache-path "$TMPDIR/swift-cache" --config-path "$TMPDIR/swift-config" --security-path "$TMPDIR/swift-security"
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/bin" "$out/lib/uomi-fluid-segments" "$out/share/licenses/uomi-fluid-segments"
    cp ${fluidAudio}/LICENSE "$out/share/licenses/uomi-fluid-segments/FluidAudio-MIT"
    cp "$TMPDIR/swift-build/arm64-apple-macosx/release/uomi-fluid-segments" "$out/lib/uomi-fluid-segments/"
    # FluidAudio 0.17.7 bundles auxiliary resources even with TTS unused.
    for bundle in "$TMPDIR/swift-build/arm64-apple-macosx/release/"*.bundle; do
      if [ -d "$bundle" ]; then cp -R "$bundle" "$out/lib/uomi-fluid-segments/"; fi
    done
    makeWrapper "$out/lib/uomi-fluid-segments/uomi-fluid-segments" "$out/bin/uomi-fluid-segments" \
      --set UOMI_FLUID_MODELS ${models}
    "$out/bin/uomi-fluid-segments" --version
    runHook postInstall
  '';
  passthru = { inherit models; };
  meta.platforms = [ "aarch64-darwin" ];
}
