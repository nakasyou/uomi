import AVFoundation
import CoreML
import FluidAudio
import Foundation

@main struct CLI {
    static let version = "uomi-fluid-v1/FluidAudio-503b4bd1bbf7220882de39fe8ae6716aae4132da/lseend-28ce1b1f8ef186729df63b3886fbaae7bc10c4a1-dih3-100ms/silero-b419383c55c110e2c9271fa6ee0ea83d03c70d96"

    static func emitProgress(_ value: Double) {
        FileHandle.standardOutput.write(Data("{\"progress\":\(value)}\n".utf8))
    }

    static func main() async {
        do { try await run() }
        catch {
            FileHandle.standardError.write(Data("uomi-fluid-segments: \(error)\n".utf8))
            exit(1)
        }
    }

    static func run() async throws {
        var args = Array(CommandLine.arguments.dropFirst())
        if args == ["--version"] { print(version); return }
        if args == ["--help"] {
            print("uomi-fluid-segments --input WAV --output JSON [--models DIRECTORY]\nRequires 16kHz mono WAV and pinned local models; no network fallback.")
            return
        }
        var options: [String: String] = [:]
        while !args.isEmpty {
            let key = args.removeFirst()
            guard ["--input", "--output", "--models"].contains(key), !args.isEmpty, options[key] == nil else {
                throw Failure("invalid arguments; use --help")
            }
            options[key] = args.removeFirst()
        }
        guard let input = options["--input"], let output = options["--output"],
              let models = options["--models"] ?? ProcessInfo.processInfo.environment["UOMI_FLUID_MODELS"] else {
            throw Failure("--input, --output and --models (or UOMI_FLUID_MODELS) are required")
        }
        // Models are fetched and checksum-verified separately at build/deploy time.
        ModelHub.offlineMode = true
        let base = URL(fileURLWithPath: models, isDirectory: true)
        let vadURL = base.appendingPathComponent("silero-vad-unified-256ms-v6.2.1.mlmodelc")
        let diarizerURL = base.appendingPathComponent("ls_eend_dih3_100ms.mlmodelc")
        for url in [vadURL, diarizerURL] {
            guard FileManager.default.fileExists(atPath: url.appendingPathComponent("coremldata.bin").path) else {
                throw Failure("pinned model missing: \(url.lastPathComponent); run fetch-models.py before starting worker")
            }
        }
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: input), commonFormat: .pcmFormatFloat32, interleaved: false)
        let format = file.processingFormat
        guard format.sampleRate == 16_000, format.channelCount == 1 else {
            throw Failure("input must be 16kHz mono WAV; got \(format.sampleRate)Hz / \(format.channelCount) channels")
        }
        let modelConfig = MLModelConfiguration()
        modelConfig.computeUnits = .cpuOnly
        let vad = VadManager(vadModel: try MLModel(contentsOf: vadURL, configuration: modelConfig))
        let diarizer = try LSEENDDiarizer(model: LSEENDModel(modelURL: diarizerURL, computeUnits: .cpuOnly))
        var state = await vad.makeStreamState()
        var speech: [Range<Int>] = []
        var start: Int?
        var samplesRead = 0
        var nextProgressSample = 80_000
        emitProgress(0)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(VadManager.chunkSize)) else {
            throw Failure("cannot allocate streaming input buffer")
        }
        while file.framePosition < file.length {
            try Task.checkCancellation()
            try file.read(into: buffer, frameCount: AVAudioFrameCount(VadManager.chunkSize))
            let count = Int(buffer.frameLength)
            guard count > 0, let channel = buffer.floatChannelData?[0] else { break }
            let samples = Array(UnsafeBufferPointer(start: channel, count: count))
            samplesRead += count
            try diarizer.addAudio(samples, sourceSampleRate: 16_000)
            _ = try diarizer.process()
            // Silero requires a complete chunk. Pad only its last input, clipping all emitted times to real duration.
            var vadSamples = samples
            if count < VadManager.chunkSize { vadSamples += Array(repeating: 0, count: VadManager.chunkSize - count) }
            let result = try await vad.processStreamingChunk(vadSamples, state: state)
            state = result.state
            if samplesRead >= nextProgressSample {
                let progress = min(0.99, Double(samplesRead) / Double(max(1, file.length)))
                emitProgress(progress)
                nextProgressSample += 80_000
            }
            if let event = result.event {
                switch event.kind {
                case .speechStart: start = event.sampleIndex
                case .speechEnd:
                    if let begin = start, event.sampleIndex > begin { speech.append(begin..<event.sampleIndex) }
                    start = nil
                }
            }
        }
        guard samplesRead == Int(file.length) else { throw Failure("short audio read: \(samplesRead)/\(file.length) samples") }
        if let begin = start, samplesRead > begin { speech.append(begin..<samplesRead) }
        // Drains pending real frames/right context and closes the final active speaker segments.
        try diarizer.finalizeSession()
        let duration = Int((Double(samplesRead) / 16).rounded())
        let intervals = speech.map { Int((Double($0.lowerBound) / 16).rounded())..<Int((Double($0.upperBound) / 16).rounded()) }
        let speakerIntervals = diarizer.timeline.speakers.values.flatMap { speaker in
            speaker.finalizedSegments.map {
                SpeechSegment(start_ms: Int((Double($0.startTime) * 1_000).rounded()),
                              end_ms: Int((Double($0.endTime) * 1_000).rounded()), speaker: "speaker_\(speaker.index)")
            }
        }
        let plan = makePlan(duration: duration, speech: intervals, speakers: speakerIntervals, version: version)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(plan).write(to: URL(fileURLWithPath: output), options: .atomic)
        emitProgress(1)
        FileHandle.standardError.write(Data("speech plan: \(duration)ms, \(plan.segments.count) intervals, VAD \(plan.vad_speech_ms)ms, unattributed \(plan.unattributed_speech_ms)ms\n".utf8))
    }
}

struct Failure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
