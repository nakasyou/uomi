import type { Recording } from './types'
import type { ChunkEndReason, AudioSegment } from './segments'

export interface RecordIndex extends Omit<Recording, 'frames'> {
  frameCount: number
  durationMs: number
  frameDurationMs?: number
  frameDurations?: number[]
  idPrefix?: string
  frameIds?: string[]
}
export interface PlanningProgress {
  phase: 'loading' | 'sorting' | 'merging' | 'grouping' | 'planning'
  completed: number
  total: number
  chunks?: number
}
export const planningLabel = {
  loading: 'Loading recording indexes into planner',
  sorting: 'Sorting recordings',
  merging: 'Merging sorted indexes',
  grouping: 'Checking continuous recording runs',
  planning: 'Planning audio chunks',
}
export interface ChunkPlan {
  key: string
  deviceId: string
  capturedAt: string | null
  durationMs: number
  sourceFrames: number
  deliveredFrames: number
  ranges: { key: string; from: number; to: number; gapMs: number }[]
  endReason: ChunkEndReason
}
export function recordIndex(record: Recording): RecordIndex {
  const { frames, ...rest } = record
  const durations = frames.map((f) => f.durationMs)
  const prefix = frames[0]?.id.replace(/0$/, '')
  const commonIds = !!prefix && frames.every((f, i) => f.id === `${prefix}${i}`)
  return {
    ...rest,
    frameCount: frames.length,
    durationMs: durations.reduce((a, b) => a + b, 0),
    ...(durations.every((d) => d === durations[0])
      ? { frameDurationMs: durations[0] ?? 20 }
      : { frameDurations: durations }),
    ...(commonIds ? { idPrefix: prefix } : { frameIds: frames.map((f) => f.id) }),
  }
}
export const frameId = (record: RecordIndex, i: number) =>
  record.idPrefix ? `${record.idPrefix}${i}` : record.frameIds![i]
export const frameDuration = (record: RecordIndex, i: number) =>
  record.frameDurationMs ?? record.frameDurations![i]
export function frameOffset(record: RecordIndex, i: number) {
  return record.frameDurationMs !== undefined
    ? record.frameDurationMs * i
    : record.frameDurations!.slice(0, i).reduce((a, b) => a + b, 0)
}
// Seconds-resolution packet stamps do not identify sub-second gaps. Fill only
// genuine boundary gaps, and only when the whole next frame still fits.
export function compareIndex(a: RecordIndex, b: RecordIndex): number {
  return (
    a.deviceId.localeCompare(b.deviceId) ||
    (a.capturedAt && b.capturedAt ? Date.parse(a.capturedAt) - Date.parse(b.capturedAt) : 0) ||
    (a.ringId ?? '').localeCompare(b.ringId ?? '') ||
    (BigInt(a.sequence) < BigInt(b.sequence) ? -1 : BigInt(a.sequence) > BigInt(b.sequence) ? 1 : 0)
  )
}
export async function cooperativePlans(
  records: RecordIndex[],
  seconds: number,
  pendingOnly = false,
  progress?: (value: PlanningProgress) => void,
): Promise<ChunkPlan[]> {
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  let runs: RecordIndex[][] = []
  progress?.({ phase: 'sorting', completed: 0, total: records.length })
  for (let start = 0; start < records.length; start += 1024) {
    runs.push(records.slice(start, start + 1024).sort(compareIndex))
    progress?.({
      phase: 'sorting',
      completed: Math.min(start + 1024, records.length),
      total: records.length,
    })
    await pause()
  }
  const mergeTotal = records.length * Math.ceil(Math.log2(Math.max(1, runs.length)))
  let mergedCount = 0
  if (mergeTotal) progress?.({ phase: 'merging', completed: 0, total: mergeTotal })
  while (runs.length > 1) {
    const next: RecordIndex[][] = []
    for (let r = 0; r < runs.length; r += 2) {
      if (!runs[r + 1]) {
        next.push(runs[r])
        mergedCount += runs[r].length
        progress?.({ phase: 'merging', completed: mergedCount, total: mergeTotal })
        continue
      }
      const a = runs[r],
        b = runs[r + 1],
        merged: RecordIndex[] = []
      let i = 0,
        j = 0
      while (i < a.length || j < b.length) {
        if (j >= b.length || (i < a.length && compareIndex(a[i], b[j]) <= 0)) merged.push(a[i++])
        else merged.push(b[j++])
        mergedCount++
        if (merged.length % 2048 === 0) {
          progress?.({ phase: 'merging', completed: mergedCount, total: mergeTotal })
          await pause()
        }
      }
      next.push(merged)
      progress?.({ phase: 'merging', completed: mergedCount, total: mergeTotal })
    }
    runs = next
  }
  const result: ChunkPlan[] = []
  for (const plan of planChunks(runs[0] ?? [], seconds, pendingOnly, true, (value) =>
    progress?.({ ...value, chunks: result.length }),
  )) {
    result.push(plan)
    await pause()
  }
  progress?.({
    phase: 'planning',
    completed: records.length,
    total: records.length,
    chunks: result.length,
  })
  return result
}
export function* planChunks(
  records: RecordIndex[],
  seconds: number,
  pendingOnly = false,
  orderedInput = false,
  progress?: (value: PlanningProgress) => void,
): Generator<ChunkPlan> {
  const maximum = seconds * 1000
  if (!Number.isFinite(maximum) || maximum <= 0) throw Error('Invalid chunk length.')
  if (!orderedInput) progress?.({ phase: 'sorting', completed: 0, total: records.length })
  const ordered = orderedInput ? records : [...records].sort(compareIndex)
  if (!orderedInput)
    progress?.({ phase: 'sorting', completed: records.length, total: records.length })
  progress?.({ phase: 'grouping', completed: 0, total: ordered.length })
  const runDuration = new Map<string, number>()
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (i % 256 === 0)
      progress?.({ phase: 'grouping', completed: ordered.length - i - 1, total: ordered.length })
    const record = ordered[i],
      next = ordered[i + 1]
    const step =
      record.capturedAt && next?.capturedAt
        ? Date.parse(next.capturedAt) - Date.parse(record.capturedAt)
        : 0
    const continuous =
      next &&
      record.deviceId === next.deviceId &&
      record.ringId === next.ringId &&
      record.timing === next.timing &&
      BigInt(next.sequence) === BigInt(record.sequence) + 1n &&
      step >= 0 &&
      step <= 2000
    runDuration.set(
      record.key,
      record.durationMs -
        (pendingOnly ? frameOffset(record, record.uploaded) : 0) +
        (continuous ? (runDuration.get(next.key) ?? 0) : 0),
    )
  }
  progress?.({ phase: 'grouping', completed: ordered.length, total: ordered.length })
  let current: ChunkPlan | undefined
  let previous: RecordIndex | undefined
  for (let index = 0; index < ordered.length; index++) {
    if (index % 256 === 0)
      progress?.({ phase: 'planning', completed: index, total: ordered.length })
    const record = ordered[index]
    let from = pendingOnly ? record.uploaded : 0
    if (from >= record.frameCount) continue
    const offset = frameOffset(record, from)
    const start = record.capturedAt ? Date.parse(record.capturedAt) + offset : NaN
    let gap = 0
    let boundary: ChunkEndReason | undefined
    if (current && previous) {
      if (current.deviceId !== record.deviceId) boundary = { kind: 'device-change' }
      else if (!Number.isFinite(start) || !current.capturedAt) {
        if (
          previous.ringId !== record.ringId ||
          BigInt(record.sequence) !== BigInt(previous.sequence) + 1n ||
          previous.timing !== record.timing
        )
          boundary = { kind: 'sequence-restart' }
      } else {
        const step = Date.parse(record.capturedAt!) - Date.parse(previous.capturedAt ?? '')
        const discontinuity =
          step > 2000 ||
          previous.ringId !== record.ringId ||
          BigInt(record.sequence) !== BigInt(previous.sequence) + 1n
        if (start < Date.parse(current.capturedAt))
          boundary = { kind: 'clock-gap', deltaMs: start - Date.parse(current.capturedAt) }
        else if (discontinuity)
          gap = Math.max(0, start - Date.parse(current.capturedAt) - current.durationMs)
        // Opus supports exact 2.5 ms durations. Keep separate when the device
        // timeline cannot be represented exactly without resampling.
        if (
          gap &&
          (Math.round(gap * 2) % 5 !== 0 ||
            current.durationMs +
              gap +
              (runDuration.get(record.key) ?? frameDuration(record, from)) >
              maximum)
        )
          boundary = { kind: 'clock-gap', deltaMs: gap }
      }
    }
    if (boundary && current) {
      yield { ...current, endReason: boundary }
      current = undefined
      gap = 0
    }
    while (from < record.frameCount) {
      if (!current)
        current = {
          key: frameId(record, from),
          deviceId: record.deviceId,
          capturedAt: record.capturedAt
            ? new Date(Date.parse(record.capturedAt) + frameOffset(record, from)).toISOString()
            : null,
          durationMs: 0,
          sourceFrames: 0,
          deliveredFrames: 0,
          ranges: [],
          endReason: { kind: 'end-of-saved-audio' },
        }
      const begin = from
      let duration = gap
      while (
        from < record.frameCount &&
        current.durationMs + duration + frameDuration(record, from) <= maximum
      ) {
        duration += frameDuration(record, from)
        from++
      }
      if (begin === from) {
        if (!current.sourceFrames) throw Error('An audio frame exceeds the chunk length.')
        yield { ...current, endReason: { kind: 'duration-limit' } }
        current = undefined
        gap = 0
        continue
      }
      current.ranges.push({ key: record.key, from: begin, to: from, gapMs: gap })
      current.durationMs += duration
      current.sourceFrames += from - begin
      current.deliveredFrames += Math.max(0, Math.min(from, record.uploaded) - begin)
      gap = 0
      if (from < record.frameCount || current.durationMs === maximum) {
        yield { ...current, endReason: { kind: 'duration-limit' } }
        current = undefined
      }
    }
    previous = record
  }
  if (current) yield current
  progress?.({ phase: 'planning', completed: ordered.length, total: ordered.length })
}
export function silenceFrames(durationMs: number, before: string): AudioSegment['frames'] {
  const frames: AudioSegment['frames'] = []
  let left = durationMs
  for (const [ms, data] of [
    [20, '+P/+'],
    [10, '8P/+'],
    [5, '6P/+'],
    [2.5, '4P/+'],
  ] as const) {
    while (left >= ms) {
      frames.push({
        id: `silence:${before}:${left}`,
        data,
        durationMs: ms,
        offsetMs: 0,
        capturedAt: null,
        recordTimestamp: 0,
        timing: 'synthetic-silence',
        sequence: '0',
        ringId: null,
      })
      left -= ms
    }
  }
  if (left !== 0) throw Error('The gap cannot be represented without resampling.')
  return frames
}
