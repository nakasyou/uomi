import { test } from 'node:test'
import assert from 'node:assert/strict'
import { audioChunks, segments } from '../src/core/segments'
import { oggOpus } from '../src/core/playback'
import type { Recording } from '../src/core/types'
function record(seq: number, frames = 5): Recording {
  return {
    key: `r${seq}`,
    deviceId: 'omi',
    ringId: 'ring',
    sequence: String(seq),
    capturedAt: null,
    timing: 'device-uptime',
    timestampRaw: 1,
    receivedAt: '2026-01-01T00:00:00Z',
    frames: Array.from({ length: frames }, (_, i) => ({
      id: `${seq}:${i}`,
      data: 'mAE=',
      offsetMs: i * 20,
      durationMs: 20,
    })),
    uploaded: 0,
    bytes: 444,
  }
}
test('library, full chunk playback and webhook share boundaries across raw packets', () => {
  const records = Array.from({ length: 1250 }, (_, i) => record(i)).reverse()
  const chunks = [...audioChunks(records, 120)]
  const outgoing = [...segments(records, 120)]
  assert.deepEqual(
    chunks.map((c) => c.segment.durationMs),
    [120000, 5000],
  )
  assert.deepEqual(
    chunks.map((c) => c.segment),
    outgoing,
  )
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].segment.frames.length, 6000)
  assert.ok(oggOpus(chunks[0].segment.frames).length > 0)
})
test('delivery status never changes chunk boundaries and retries omit acknowledged frames', () => {
  const records = [record(0, 80), record(1, 80)]
  const before = [...audioChunks(records, 1)]
  records[0].uploaded = 79
  const after = [...audioChunks(records, 1)]
  assert.deepEqual(
    after.map((c) => c.segment),
    before.map((c) => c.segment),
  )
  assert.deepEqual(
    after.map((c) => c.deliveredFrames),
    [50, 29, 0, 0],
  )
  assert.deepEqual(
    [...segments(records, 1)].map((s) => s.durationMs),
    [420, 1000, 200],
  )
})
test('chunks split at sequence gaps, devices, ring resets and clock discontinuities', () => {
  for (const next of [
    record(2),
    { ...record(1), deviceId: 'other' },
    { ...record(1), ringId: 'reset' },
  ])
    assert.equal([...audioChunks([record(0), next], 60)].length, 2)
  const a = {
    ...record(0),
    capturedAt: '2026-01-01T00:00:00Z',
    timing: 'device-utc' as const,
  }
  const b = {
    ...record(1),
    capturedAt: '2026-01-01T00:01:01Z',
    timing: 'device-utc' as const,
  }
  assert.equal([...audioChunks([a, b], 120)].length, 2)
})
test('resizing chunks preserves all original frame identities and delivery state', () => {
  const records = Array.from({ length: 100 }, (_, i) => record(i))
  const original = JSON.stringify(records)
  const ids = (seconds: number) =>
    [...audioChunks(records, seconds)].flatMap((c) => c.segment.frames.map((f) => f.id))
  assert.deepEqual(ids(1), ids(60))
  assert.equal(JSON.stringify(records), original)
})

test('chunk endings explain the actual boundary rather than guessing missing audio', () => {
  const a = record(0)
  const gap = [...audioChunks([a, record(4)], 60)]
  assert.deepEqual(gap[0].endReason, {
    kind: 'sequence-gap',
    unavailablePackets: '3',
  })
  assert.deepEqual(gap[1].endReason, { kind: 'end-of-saved-audio' })
  assert.equal(
    [...audioChunks([a, { ...record(1), deviceId: 'other' }], 60)][0].endReason.kind,
    'device-change',
  )
  assert.equal(
    [...audioChunks([a, { ...record(1), ringId: 'other' }], 60)][0].endReason.kind,
    'ring-change',
  )
  assert.equal([...audioChunks([record(0, 100)], 1)][0].endReason.kind, 'duration-limit')
  const utc = {
    ...a,
    timing: 'device-utc' as const,
    capturedAt: '2026-01-01T00:00:00Z',
  }
  const later = {
    ...record(1),
    timing: 'device-utc' as const,
    capturedAt: '2026-01-01T00:01:01Z',
  }
  assert.deepEqual([...audioChunks([utc, later], 60)][0].endReason, {
    kind: 'clock-gap',
    deltaMs: 61000,
  })
  assert.equal(
    [
      ...audioChunks(
        [
          a,
          {
            ...record(1),
            timing: 'device-utc',
            capturedAt: '2026-01-01T00:00:10Z',
          },
        ],
        60,
      ),
    ][0].endReason.kind,
    'clock-mode-change',
  )
})

test('short timestamp steps do not fragment audio and are reported as metadata', () => {
  const a = {
    ...record(0),
    timing: 'device-utc' as const,
    capturedAt: '2026-01-01T00:00:00Z',
  }
  for (const step of [3, 5, 12, 60]) {
    const b = {
      ...record(1),
      timing: 'device-utc' as const,
      capturedAt: new Date(Date.parse(a.capturedAt) + step * 1000).toISOString(),
    }
    const chunks = [...audioChunks([a, b], 120)]
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].segment.durationMs, 200)
    assert.deepEqual(chunks[0].timestampGaps, {
      count: 1,
      approximateMs: step * 1000 - 100,
    })
    assert.equal(chunks[0].endReason.kind, 'end-of-saved-audio')
    assert.deepEqual([...segments([a, b], 120)][0], chunks[0].segment)
  }
})
test('backwards clock steps split even when smaller than two seconds', () => {
  const a = {
    ...record(0),
    timing: 'device-utc' as const,
    capturedAt: '2026-01-01T00:00:01Z',
  }
  const b = {
    ...record(1),
    timing: 'device-utc' as const,
    capturedAt: '2026-01-01T00:00:00Z',
  }
  const chunks = [...audioChunks([a, b], 120)]
  assert.equal(chunks.length, 2)
  assert.deepEqual(chunks[0].endReason, { kind: 'clock-gap', deltaMs: -1000 })
})
test('seconds-resolution timestamps and long packets do not cause false clock reversals', () => {
  const a = {
    ...record(0, 150),
    timing: 'device-utc' as const,
    capturedAt: '2026-01-01T00:00:00Z',
  }
  const b = {
    ...record(1),
    timing: 'device-utc' as const,
    capturedAt: '2026-01-01T00:00:00Z',
  }
  const chunks = [...audioChunks([a, b], 120)]
  assert.equal(chunks.length, 1)
  assert.deepEqual(chunks[0].timestampGaps, { count: 0, approximateMs: 0 })
})
