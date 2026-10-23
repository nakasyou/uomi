import Foundation

struct SpeechSegment: Codable, Equatable {
    let start_ms: Int
    let end_ms: Int
    let speaker: String?

    // An explicit null means speech detected without a confident speaker attribution.
    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(start_ms, forKey: .start_ms)
        try c.encode(end_ms, forKey: .end_ms)
        if let speaker { try c.encode(speaker, forKey: .speaker) }
        else { try c.encodeNil(forKey: .speaker) }
    }
}

struct SpeechPlan: Encodable {
    let schema = "uomi.speech-plan.v1"
    let engine: String
    let duration_ms: Int
    let segments: [SpeechSegment]
    let vad_speech_ms: Int
    let unattributed_speech_ms: Int
    let overlap_policy = "overlapping speaker intervals; mixed source audio, no source separation"
}

/// Preserve all VAD speech, including unattributed regions, and overlapping model speakers.
/// Intersect on original time; do not concatenate speech before diarization.
func makePlan(duration: Int, speech: [Range<Int>], speakers: [SpeechSegment], version: String) -> SpeechPlan {
    var output: [SpeechSegment] = []
    var total = 0
    var unknown = 0
    for raw in speech {
        let lo = max(0, raw.lowerBound), hi = min(duration, raw.upperBound)
        guard hi > lo else { continue }
        total += hi - lo
        let hits = speakers.compactMap { s -> SpeechSegment? in
            let start = max(lo, s.start_ms), end = min(hi, s.end_ms)
            return end > start ? SpeechSegment(start_ms: start, end_ms: end, speaker: s.speaker) : nil
        }.sorted { $0.start_ms < $1.start_ms }
        output.append(contentsOf: hits)
        var coveredUntil = lo
        for hit in hits {
            if hit.start_ms > coveredUntil {
                output.append(SpeechSegment(start_ms: coveredUntil, end_ms: hit.start_ms, speaker: nil))
                unknown += hit.start_ms - coveredUntil
            }
            coveredUntil = max(coveredUntil, hit.end_ms)
        }
        if coveredUntil < hi {
            output.append(SpeechSegment(start_ms: coveredUntil, end_ms: hi, speaker: nil))
            unknown += hi - coveredUntil
        }
    }
    output.sort {
        if $0.start_ms != $1.start_ms { return $0.start_ms < $1.start_ms }
        if $0.end_ms != $1.end_ms { return $0.end_ms < $1.end_ms }
        return ($0.speaker ?? "") < ($1.speaker ?? "")
    }
    return SpeechPlan(engine: version, duration_ms: duration, segments: output,
                      vad_speech_ms: total, unattributed_speech_ms: unknown)
}
