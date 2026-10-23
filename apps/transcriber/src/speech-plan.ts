import { createHash } from 'node:crypto'

export type SpeechInterval = {
  start_ms: number
  end_ms: number
  speaker: string | null
}
export type SpeechPlan = {
  schema: 'uomi.speech-plan.v1'
  duration_ms: number
  engine?: string
  segments: SpeechInterval[]
}

export const MAX_ASR_SEGMENT_MS = 600_000
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000
const MAX_INPUT_SEGMENTS = 100_000
const MAX_OUTPUT_SEGMENTS = 20_000

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function speaker(value: unknown): value is string | null {
  return (
    value === null || (typeof value === 'string' && value.trim().length > 0 && value.length <= 200)
  )
}

/**
 * Validate helper output and keep one source-audio interval for each active
 * speaker set. Null is an unidentified speaker, including in overlapping audio.
 * Composite labels use JSON escaping to keep speaker IDs unambiguous.
 */
export function normalizeSpeechPlan(input: unknown, expectedDurationMs?: number): SpeechPlan {
  if (!object(input) || input.schema !== 'uomi.speech-plan.v1') {
    throw new Error('Invalid speech plan schema')
  }
  const duration = input.duration_ms
  if (!finite(duration) || duration <= 0 || duration > MAX_DURATION_MS) {
    throw new Error('Invalid speech plan duration (must be positive and at most seven days)')
  }
  if (expectedDurationMs !== undefined) {
    if (
      !finite(expectedDurationMs) ||
      expectedDurationMs <= 0 ||
      Math.abs(duration - expectedDurationMs) > 1000
    ) {
      throw new Error('Speech plan duration differs from source audio')
    }
  }
  if (!Array.isArray(input.segments) || input.segments.length > MAX_INPUT_SEGMENTS) {
    throw new Error('Invalid speech plan segment count')
  }
  if (
    input.engine !== undefined &&
    (typeof input.engine !== 'string' || !input.engine.trim() || input.engine.length > 1024)
  ) {
    throw new Error('Invalid speech helper engine version')
  }
  type Event = { time: number; label: string | null; delta: number }
  const events: Event[] = []
  let labelBytes = 0
  for (const segment of input.segments) {
    if (
      !object(segment) ||
      !finite(segment.start_ms) ||
      !finite(segment.end_ms) ||
      segment.start_ms < 0 ||
      segment.end_ms <= segment.start_ms ||
      segment.start_ms >= duration ||
      segment.end_ms > duration + 1 ||
      !speaker(segment.speaker)
    ) {
      throw new Error('Invalid speech plan segment bounds or speaker')
    }
    labelBytes += segment.speaker?.length ?? 0
    if (labelBytes > 2_000_000) throw new Error('Speech plan speaker labels exceed size limit')
    events.push({ time: segment.start_ms, label: segment.speaker, delta: 1 })
    events.push({ time: Math.min(segment.end_ms, duration), label: segment.speaker, delta: -1 })
  }
  events.sort((a, b) => a.time - b.time)
  const active = new Map<string | null, number>()
  const merged: (SpeechInterval & { identity: string })[] = []
  let outputLabelBytes = 0
  let previousTime = 0
  for (let index = 0; index < events.length;) {
    const time = events[index].time
    if (time > previousTime && active.size) {
      if (active.size > 64) throw new Error('Speech plan has too many simultaneous speakers')
      const labels = [...active.keys()].sort((a, b) =>
        a === null ? -1 : b === null ? 1 : a < b ? -1 : a > b ? 1 : 0,
      )
      // Compare speaker sets rather than display labels, which could resemble a
      // real single-speaker ID. Store the set separately until normalization ends.
      const identity = JSON.stringify(labels)
      const label = labels.length === 1 ? labels[0] : `overlap:${identity}`
      if (label !== null && label.length > 200)
        throw new Error('Composite speech speaker label exceeds API limit of 200 characters')
      const previous = merged[merged.length - 1]
      if (previous && previous.end_ms === previousTime && previous.identity === identity) {
        previous.end_ms = time
      } else {
        outputLabelBytes += label?.length ?? 0
        if (outputLabelBytes > 16_000_000)
          throw new Error('Normalized speech labels exceed size limit')
        merged.push({ start_ms: previousTime, end_ms: time, speaker: label, identity })
      }
    }
    while (index < events.length && events[index].time === time) {
      const event = events[index++]
      const count = (active.get(event.label) ?? 0) + event.delta
      if (count === 0) active.delete(event.label)
      else active.set(event.label, count)
    }
    previousTime = time
  }
  const segments: SpeechInterval[] = []
  for (const interval of merged) {
    for (let start = interval.start_ms; start < interval.end_ms;) {
      const end = Math.min(start + MAX_ASR_SEGMENT_MS, interval.end_ms)
      segments.push({ start_ms: start, end_ms: end, speaker: interval.speaker })
      if (segments.length > MAX_OUTPUT_SEGMENTS)
        throw new Error('Speech plan exceeds API limit of 20000 normalized segments')
      start = end
    }
  }
  return {
    schema: 'uomi.speech-plan.v1',
    duration_ms: duration,
    ...(input.engine !== undefined ? { engine: input.engine as string } : {}),
    segments,
  }
}

/** Checkpoints must change if either the model/engine or normalized plan changes. */
export function speechPlanFingerprint(plan: SpeechPlan, helperEngineVersion: string): string {
  if (!helperEngineVersion.trim() || helperEngineVersion.length > 1024) {
    throw new Error('Missing or invalid speech helper engine version')
  }
  const normalized = normalizeSpeechPlan(plan)
  return createHash('sha256')
    .update(
      JSON.stringify({
        normalization: 1,
        helperEngineVersion,
        ...normalized,
      }),
    )
    .digest('hex')
}

/** Map ASR times relative to one trimmed slice back onto the original audio. */
export function offsetSpeechSegments<T extends { start_ms: number; end_ms: number }>(
  segments: readonly T[],
  slice: SpeechInterval,
): (T & { speaker: string | null })[] {
  if (
    !finite(slice.start_ms) ||
    !finite(slice.end_ms) ||
    slice.start_ms < 0 ||
    slice.end_ms <= slice.start_ms ||
    !speaker(slice.speaker)
  ) {
    throw new Error('Invalid source speech slice')
  }
  return segments.map((segment) => {
    if (
      !finite(segment.start_ms) ||
      !finite(segment.end_ms) ||
      segment.start_ms < 0 ||
      segment.end_ms < segment.start_ms ||
      segment.end_ms > slice.end_ms - slice.start_ms
    ) {
      throw new Error('ASR segment times exceed the trimmed speech slice')
    }
    return {
      ...segment,
      start_ms: slice.start_ms + segment.start_ms,
      end_ms: slice.start_ms + segment.end_ms,
      speaker: slice.speaker,
    }
  })
}
