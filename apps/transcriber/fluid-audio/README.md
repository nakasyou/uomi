# Uomi local speech planner

`uomi-fluid-segments --input recording.wav --output plan.json --models /path/to/models`

The input must be 16 kHz mono audio. The helper reads 4,096 frames at a time with
`AVAudioFile`, sends the full original timeline to both Silero streaming VAD and
LS-EEND streaming diarization, and calls `finalizeSession()` at EOF. Audio samples
are not accumulated for the whole recording. The finalized speaker intervals are
intersected with VAD speech. Silence produces an empty plan, not a full-file fallback.
VAD-positive speech without an assigned model speaker is retained with `speaker:null`.

The JSON schema is `uomi.speech-plan.v1`, with `duration_ms`, `engine`, `segments`
(`start_ms`, `end_ms`, `speaker`), `vad_speech_ms`, and `unattributed_speech_ms`.
JSONL progress records (`{"progress":0..1}`) are emitted on stdout every five source
seconds and reach 1 after finalization and successful output writing.

Times refer to the original input. Overlapping model speakers remain overlapping
intervals. The source audio is mixed; this helper does not separate simultaneous
voices or guarantee speaker identity across recordings. LS-EEND provides up to ten
speaker slots per session. `speaker_N` names an actual model slot, not a person.

FluidAudio **v0.17.7** is pinned to Git commit
`503b4bd1bbf7220882de39fe8ae6716aae4132da`. Swift 6.2 is required; the NeMo binary
trait is disabled. This release still compiles the unused TTS sources. Models are
pinned independently in `models.lock.json`: LS-EEND DIHARD3 / 100 ms at
`28ce1b1f8ef186729df63b3886fbaae7bc10c4a1` and Silero VAD v6.2.1 at
`b419383c55c110e2c9271fa6ee0ea83d03c70d96`. Every model file has a SHA256 and size.
`fetch-models.py DIRECTORY` downloads and validates these public artifacts before
runtime. The helper uses direct local CoreML loaders with `ModelHub.offlineMode=true`;
missing or invalid models fail explicitly. Production Nix fetches the same immutable
artifacts with fixed hashes into the Nix store. Both models use CPU-only inference.
The SDK and both model cards specify MIT licenses. See the official
[LS-EEND model card](https://huggingface.co/FluidInference/ls-eend-coreml) and
[Silero model card](https://huggingface.co/FluidInference/silero-vad-coreml).

`package.nix` is the production build recipe. It vendors the pinned SDK as a local
SwiftPM dependency and replaces only its package manifest to omit the unused NeMo
binary download. It checks the installed Apple Swift 6.2.4 compiler exactly; the
Apple toolchain itself is a host prerequisite, not a downloaded Nix compiler. The
helper and all model files are built into immutable Nix store outputs.

Build and verify on Apple Silicon macOS with Swift 6.2:

```sh
swift build -c release
swiftc Sources/UomiFluidSegments/Plan.swift Tests/main.swift -o /tmp/uomi-plan-tests
/tmp/uomi-plan-tests
python3 fetch-models.py /tmp/uomi-fluid-models
python3 test-fixtures.py .build/release/uomi-fluid-segments /tmp/uomi-fluid-models
```

The fixture test requires `ffmpeg` and built-in macOS `say` voices Samantha/Daniel.
It generates public synthetic sentences locally, checks real CoreML outputs for
sequential and overlapping voices, silence removal, original timestamps, EOF
finalization, and explicit missing-model failure. It uploads no audio. No XCTest
installation is needed (Apple Command Line Tools do not ship XCTest or Testing).

Official API/source references:
[FluidAudio](https://github.com/FluidInference/FluidAudio/tree/503b4bd1bbf7220882de39fe8ae6716aae4132da),
[streaming VAD](https://github.com/FluidInference/FluidAudio/blob/503b4bd1bbf7220882de39fe8ae6716aae4132da/Sources/FluidAudio/VAD/VadManager%2BStreaming.swift),
[LS-EEND streaming/finalization](https://github.com/FluidInference/FluidAudio/blob/503b4bd1bbf7220882de39fe8ae6716aae4132da/Sources/FluidAudio/Diarizer/LS-EEND/LSEENDDiarizer.swift).
