import Foundation

func testIntersectsSpeechAndPreservesOverlapAndUnknownSpeech() throws {
    let plan = makePlan(duration: 10_000, speech: [1_000..<5_000, 8_000..<12_000], speakers: [
        SpeechSegment(start_ms: 0, end_ms: 3_000, speaker: "speaker_0"),
        SpeechSegment(start_ms: 2_000, end_ms: 4_000, speaker: "speaker_1")
    ], version: "test")
    precondition(plan.vad_speech_ms == 6_000)
    precondition(plan.unattributed_speech_ms == 3_000)
    precondition(plan.segments == [
        SpeechSegment(start_ms: 1_000, end_ms: 3_000, speaker: "speaker_0"),
        SpeechSegment(start_ms: 2_000, end_ms: 4_000, speaker: "speaker_1"),
        SpeechSegment(start_ms: 4_000, end_ms: 5_000, speaker: nil),
        SpeechSegment(start_ms: 8_000, end_ms: 10_000, speaker: nil)
    ])
}

func testSilenceDoesNotFallBackToFullRecording() {
    precondition(makePlan(duration: 10_000, speech: [], speakers: [], version: "test").segments.isEmpty)
}

try testIntersectsSpeechAndPreservesOverlapAndUnknownSpeech()
testSilenceDoesNotFallBackToFullRecording()
let encoded = try JSONEncoder().encode(SpeechSegment(start_ms: 0, end_ms: 1, speaker: nil))
precondition(String(decoding: encoded, as: UTF8.self).contains("\"speaker\":null"))
print("Plan tests passed: clipping, original gaps, overlap, unknown speech, silence, explicit null")
