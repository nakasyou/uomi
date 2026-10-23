import { expect, test } from 'bun:test'
import {
  MAX_ASR_SEGMENT_MS,
  normalizeSpeechPlan,
  offsetSpeechSegments,
  speechPlanFingerprint,
  type SpeechInterval,
} from '../src/speech-plan'

const interval = (
  start_ms: number,
  end_ms: number,
  speaker: string | null = null,
): SpeechInterval => ({ start_ms, end_ms, speaker })
const plan = (segments: SpeechInterval[], duration_ms = 10_000) => ({
  schema: 'uomi.speech-plan.v1',
  duration_ms,
  segments,
})

test('overlapping speakers are recognized once, with original times and honest unknown labels', () => {
  const input = plan([
    interval(1000, 5000, 'speaker1'),
    interval(3000, 6000, 'speaker2'),
    interval(4000, 4500),
    interval(8000, 8100),
  ])
  const result = normalizeSpeechPlan(input)
  expect(result.segments).toEqual([
    interval(1000, 3000, 'speaker1'),
    interval(3000, 4000, 'overlap:["speaker1","speaker2"]'),
    interval(4000, 4500, 'overlap:[null,"speaker1","speaker2"]'),
    interval(4500, 5000, 'overlap:["speaker1","speaker2"]'),
    interval(5000, 6000, 'speaker2'),
    interval(8000, 8100),
  ])
  expect(result.segments.reduce((sum, segment) => sum + segment.end_ms - segment.start_ms, 0)).toBe(
    5100,
  )
  expect(input.segments[0].end_ms).toBe(5000)
})

test('duplicate same-speaker overlaps and exact adjacency merge but silence gaps remain', () => {
  expect(
    normalizeSpeechPlan(
      plan([
        interval(0, 1000, 'a'),
        interval(500, 1500, 'a'),
        interval(1500, 2000, 'a'),
        interval(2001, 2500, 'a'),
        interval(2500, 3000, 'b'),
      ]),
    ).segments,
  ).toEqual([interval(0, 2000, 'a'), interval(2001, 2500, 'a'), interval(2500, 3000, 'b')])
})

test('long speech is capped at Google ten-minute slices without losing source offsets', () => {
  const segments = normalizeSpeechPlan(
    plan([interval(123, 1_300_123, 'speaker1')], 1_400_000),
  ).segments
  expect(segments).toEqual([
    interval(123, 600_123, 'speaker1'),
    interval(600_123, 1_200_123, 'speaker1'),
    interval(1_200_123, 1_300_123, 'speaker1'),
  ])
  expect(segments.every((segment) => segment.end_ms - segment.start_ms <= MAX_ASR_SEGMENT_MS)).toBe(
    true,
  )
})

test('silent recordings and tiny genuine speech intervals are preserved honestly', () => {
  expect(normalizeSpeechPlan(plan([])).segments).toEqual([])
  expect(normalizeSpeechPlan(plan([interval(1.1, 1.2)])).segments).toEqual([interval(1.1, 1.2)])
  expect(normalizeSpeechPlan(plan([interval(9999, 10000.5)])).segments).toEqual([
    interval(9999, 10000),
  ])
})

test('helper/source decoder duration tolerance does not permit a materially different recording', () => {
  expect(normalizeSpeechPlan(plan([]), 10_900).duration_ms).toBe(10_000)
  expect(() => normalizeSpeechPlan(plan([]), 11_001)).toThrow('duration differs')
  expect(() => normalizeSpeechPlan(plan([]), NaN)).toThrow('duration differs')
})

test('malformed plans fail before any audio work', () => {
  for (const value of [
    null,
    {},
    { ...plan([]), schema: 'wrong' },
    plan([], 0),
    plan([], NaN),
    plan([], Infinity),
    plan([], 8 * 86400_000),
    plan([interval(-1, 100)]),
    plan([interval(2, 1)]),
    plan([interval(1, 1)]),
    plan([interval(0, Infinity)]),
    plan([interval(NaN, 10)]),
    plan([interval(10000, 10000.5)]),
    plan([interval(0, 10002)]),
    plan([interval(0, 10, '')]),
    plan([interval(0, 10, '  ')]),
    plan([{ start_ms: 0, end_ms: 10 } as SpeechInterval]),
    { ...plan([]), engine: '' },
    { ...plan([]), segments: null },
    plan(Array.from({ length: 100_001 }, () => interval(0, 1))),
    plan(Array.from({ length: 65 }, (_, index) => interval(0, 100, `speaker${index}`))),
  ])
    expect(() => normalizeSpeechPlan(value)).toThrow()
})

test('stable checkpoint fingerprint tracks source times, engine, speaker and duration', () => {
  const first = normalizeSpeechPlan({
    ...plan([interval(100, 1000, 'a'), interval(500, 2000, 'b')]),
    engine: 'fluid-v1/models-2026',
  })
  const reordered = normalizeSpeechPlan({ ...first, segments: [...first.segments].reverse() })
  const hash = speechPlanFingerprint(first, first.engine!)
  expect(hash).toMatch(/^[a-f0-9]{64}$/)
  expect(speechPlanFingerprint(reordered, first.engine!)).toBe(hash)
  expect(speechPlanFingerprint(first, 'fluid-v2/models-2026')).not.toBe(hash)
  expect(speechPlanFingerprint({ ...first, duration_ms: 10_001 }, first.engine!)).not.toBe(hash)
  expect(
    speechPlanFingerprint({ ...first, segments: [interval(101, 1000, 'a')] }, first.engine!),
  ).not.toBe(hash)
  expect(
    speechPlanFingerprint({ ...first, segments: [interval(100, 1000, 'b')] }, first.engine!),
  ).not.toBe(hash)
  expect(() => speechPlanFingerprint(first, '')).toThrow()
})

test('ASR slice timestamps map to original timeline and inherit diarization speaker', () => {
  const recognized = [{ start_ms: 100, end_ms: 900, text: 'hello', speaker: 'provider-guess' }]
  expect(offsetSpeechSegments(recognized, interval(42_000, 43_000, 'speaker2'))).toEqual([
    { start_ms: 42_100, end_ms: 42_900, text: 'hello', speaker: 'speaker2' },
  ])
  expect(offsetSpeechSegments(recognized, interval(42_000, 43_000))[0].speaker).toBeNull()
  expect(recognized[0].start_ms).toBe(100)
  for (const segment of [interval(-1, 1), interval(1, 1001), interval(5, 4), interval(NaN, 10)]) {
    expect(() => offsetSpeechSegments([segment], interval(42_000, 43_000))).toThrow()
  }
})

test('sweep preserves the exact speech union across varied nested and crossing intervals', () => {
  let seed = 71
  const random = (max: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed % max
  }
  for (let trial = 0; trial < 100; trial++) {
    const source = Array.from({ length: 30 }, () => {
      const start = random(99)
      return interval(start, start + 1 + random(100 - start), [null, 'a', 'b'][random(3)])
    })
    const normalized = normalizeSpeechPlan(plan(source, 100)).segments
    for (let index = 1; index < normalized.length; index++) {
      expect(normalized[index].start_ms >= normalized[index - 1].end_ms).toBe(true)
    }
    for (let sample = 0.5; sample < 100; sample++) {
      const active = [
        ...new Set(
          source
            .filter((segment) => segment.start_ms <= sample && segment.end_ms > sample)
            .map((segment) => segment.speaker),
        ),
      ].sort((a, b) => (a === null ? -1 : b === null ? 1 : a < b ? -1 : a > b ? 1 : 0))
      const matches = normalized.filter(
        (segment) => segment.start_ms <= sample && segment.end_ms > sample,
      )
      expect(matches.length).toBe(active.length ? 1 : 0)
      if (active.length)
        expect(matches[0].speaker).toBe(
          active.length === 1 ? active[0] : `overlap:${JSON.stringify(active)}`,
        )
    }
  }
})

test('speaker and normalized segment limits match the transcript API without truncation', () => {
  expect(
    normalizeSpeechPlan(plan([interval(0, 1, 'a'.repeat(200))])).segments[0].speaker,
  ).toHaveLength(200)
  expect(() => normalizeSpeechPlan(plan([interval(0, 1, 'a'.repeat(201))]))).toThrow('speaker')
  expect(() =>
    normalizeSpeechPlan(
      plan([interval(0, 100, 'a'.repeat(100)), interval(0, 100, 'b'.repeat(100))]),
    ),
  ).toThrow('Composite speech speaker label exceeds API limit')
  const sparse = Array.from({ length: 20_000 }, (_, index) => interval(index * 2, index * 2 + 1))
  expect(normalizeSpeechPlan(plan(sparse, 40_002)).segments).toHaveLength(20_000)
  expect(() => normalizeSpeechPlan(plan([...sparse, interval(40_000, 40_001)], 40_002))).toThrow(
    'API limit of 20000 normalized segments',
  )
  // The cap applies after exact-adjacent same-speaker merging.
  const adjacent = Array.from({ length: 20_001 }, (_, index) => interval(index, index + 1))
  expect(normalizeSpeechPlan(plan(adjacent, 20_002)).segments).toEqual([interval(0, 20_001)])
})
