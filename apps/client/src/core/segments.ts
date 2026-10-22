import type { Recording } from './types'
export interface AudioSegment {
  schema: 'uomi.audio.v1'
  deviceId: string
  codec: 'opus'
  sampleRate: 16000
  channels: 1
  durationMs: number
  frames: {
    id: string
    data: string
    durationMs: number
    capturedAt: string | null
    offsetMs: number
    recordTimestamp: number
    timing: string
    sequence: string
    ringId: string | null
  }[]
}
// Match the official ring sync: seconds-resolution storage timestamps are
// not sample clocks. Split on backwards steps or forward steps over 60s.
export const CLOCK_GAP_BREAK_MS = 60000
export type ChunkEndReason =
  | {
      kind:
        | 'duration-limit'
        | 'device-change'
        | 'ring-change'
        | 'sequence-restart'
        | 'clock-mode-change'
        | 'end-of-saved-audio'
    }
  | { kind: 'sequence-gap'; unavailablePackets: string }
  | { kind: 'clock-gap'; deltaMs: number }
export function chunkEndLabel(reason: ChunkEndReason): string {
  switch (reason.kind) {
    case 'duration-limit':
      return 'Maximum chunk length reached'
    case 'device-change':
      return 'Next audio is from another device'
    case 'ring-change':
      return 'Device storage identity changed'
    case 'sequence-restart':
      return 'Packet sequence restarted or repeated'
    case 'clock-mode-change':
      return 'Device timestamp mode changed'
    case 'end-of-saved-audio':
      return 'End of currently saved audio'
    case 'sequence-gap':
      return `Sequence gap · ${reason.unavailablePackets} packets unavailable locally`
    case 'clock-gap':
      return `Device timestamp moved ${reason.deltaMs < 0 ? 'backward' : 'forward'} · ${(Math.abs(reason.deltaMs) / 1000).toFixed(1)}s`
  }
}
export interface AudioChunk {
  endReason: ChunkEndReason
  timestampGaps: { count: number; approximateMs: number }
  key: string
  segment: AudioSegment
  deliveredFrames: number
}

// One canonical boundary calculation for library rows, playback and delivery.
// Keep raw packet/frame identities intact; grouping never changes stored audio.
export function* audioChunks(records: Recording[], seconds: number): Generator<AudioChunk> {
  if (!Number.isFinite(seconds) || seconds <= 0) throw Error('Invalid chunk length.')
  const ordered = [...records].sort(
    (a, b) =>
      a.deviceId.localeCompare(b.deviceId) ||
      (a.ringId ?? '').localeCompare(b.ringId ?? '') ||
      (BigInt(a.sequence) < BigInt(b.sequence)
        ? -1
        : BigInt(a.sequence) > BigInt(b.sequence)
          ? 1
          : a.receivedAt.localeCompare(b.receivedAt)),
  )
  let current: AudioChunk | undefined
  let previous: Recording | undefined
  for (const r of ordered) {
    let reason: ChunkEndReason | undefined
    let gapMs = 0
    if (previous) {
      const sequenceDelta = BigInt(r.sequence) - BigInt(previous.sequence)
      const clockStep =
        r.capturedAt && previous.capturedAt
          ? Date.parse(r.capturedAt) - Date.parse(previous.capturedAt)
          : 0
      // A short forward gap is metadata, not proof of lost BLE packets.
      if (clockStep > 2000 && clockStep <= CLOCK_GAP_BREAK_MS)
        gapMs = Math.max(0, clockStep - previous.frames.reduce((n, f) => n + f.durationMs, 0))
      if (r.deviceId !== previous.deviceId) reason = { kind: 'device-change' }
      else if (r.ringId !== previous.ringId) reason = { kind: 'ring-change' }
      else if (sequenceDelta > 1n)
        reason = {
          kind: 'sequence-gap',
          unavailablePackets: (sequenceDelta - 1n).toString(),
        }
      else if (sequenceDelta !== 1n) reason = { kind: 'sequence-restart' }
      else if (r.timing !== previous.timing) reason = { kind: 'clock-mode-change' }
      else if (clockStep < 0 || clockStep > CLOCK_GAP_BREAK_MS)
        reason = { kind: 'clock-gap', deltaMs: clockStep }
    }
    if (reason && current) {
      yield { ...current, endReason: reason }
      current = undefined
    }
    for (const [i, f] of r.frames.entries()) {
      if (f.durationMs > seconds * 1000) throw Error('An audio frame exceeds the chunk length.')
      if (current && current.segment.durationMs + f.durationMs > seconds * 1000) {
        yield { ...current, endReason: { kind: 'duration-limit' } }
        current = undefined
      }
      if (!current)
        current = {
          key: f.id,
          endReason: { kind: 'end-of-saved-audio' },
          timestampGaps: { count: 0, approximateMs: 0 },
          deliveredFrames: 0,
          segment: {
            schema: 'uomi.audio.v1',
            deviceId: r.deviceId,
            codec: 'opus',
            sampleRate: 16000,
            channels: 1,
            durationMs: 0,
            frames: [],
          },
        }
      if (i === 0 && !reason && gapMs > 0) {
        current.timestampGaps.count++
        current.timestampGaps.approximateMs += gapMs
      }
      current.segment.frames.push({
        ...f,
        capturedAt: r.capturedAt
          ? new Date(Date.parse(r.capturedAt) + f.offsetMs).toISOString()
          : null,
        recordTimestamp: r.timestampRaw,
        timing: r.timing,
        sequence: r.sequence,
        ringId: r.ringId,
      })
      current.segment.durationMs += f.durationMs
      if (i < r.uploaded) current.deliveredFrames++
    }
    previous = r
  }
  if (current)
    yield current.segment.durationMs >= seconds * 1000
      ? { ...current, endReason: { kind: 'duration-limit' } }
      : current
}

export function* segments(records: Recording[], seconds: number): Generator<AudioSegment> {
  // Omit acknowledged frames without changing the canonical chunk boundaries.
  const acknowledged = new Set(
    records.flatMap((r) => r.frames.slice(0, r.uploaded).map((f) => f.id)),
  )
  for (const { segment } of audioChunks(records, seconds)) {
    const frames = segment.frames.filter((f) => !acknowledged.has(f.id))
    if (frames.length)
      yield {
        ...segment,
        frames,
        durationMs: frames.reduce((n, f) => n + f.durationMs, 0),
      }
  }
}
export function periodicDue(last: string | null, hours: number, now = Date.now()): boolean {
  return last === null || now - Date.parse(last) >= hours * 3600000
}
