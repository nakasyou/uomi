import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { recordIndex, planChunks, silenceFrames } from '../src/core/catalog'
import { oggOpus, oggFrames } from '../src/core/playback'
import type { Recording } from '../src/core/types'
const record = (sequence: number, start: string, count = 50): Recording => ({
  key: `record:${sequence}`,
  deviceId: 'omi',
  ringId: '1',
  sequence: String(sequence),
  capturedAt: start,
  timestampRaw: 1,
  timing: 'device-utc',
  frames: Array.from({ length: count }, (_, i) => ({
    id: `source:${sequence}:${i}`,
    data: '+P/+',
    durationMs: 20,
    offsetMs: i * 20,
  })),
  uploaded: 0,
  bytes: 100,
  receivedAt: start,
})
test('catalog planning fills an exact gap without changing source audio or exceeding the maximum', () => {
  const records = [record(0, '2026-01-01T00:00:00Z'), record(100, '2026-01-01T00:00:10Z')]
  const before = JSON.stringify(records)
  const plans = [...planChunks(records.map(recordIndex), 60)]
  assert.equal(plans.length, 1)
  assert.equal(plans[0].durationMs, 11000)
  assert.equal(plans[0].sourceFrames, 100)
  assert.equal(plans[0].ranges[1].gapMs, 9000)
  assert.equal(JSON.stringify(records), before)
  assert.equal([...planChunks(records.map(recordIndex), 10)].length, 2)
})
test('catalog keeps isolated audio, different devices, and unrepresentable gaps separate', () => {
  const first = record(0, '2026-01-01T00:00:00Z')
  assert.equal([...planChunks([recordIndex(first)], 60)].length, 1)
  assert.equal(
    [...planChunks([recordIndex(first), recordIndex(record(2, '2026-01-01T00:20:00Z'))], 60)]
      .length,
    2,
  )
  const fraction = record(2, '2026-01-01T00:00:10.001Z')
  assert.equal([...planChunks([recordIndex(first), recordIndex(fraction)], 60)].length, 2)
  const other = { ...record(2, '2026-01-01T00:00:10Z'), deviceId: 'other' }
  assert.equal([...planChunks([recordIndex(first), recordIndex(other)], 60)].length, 2)
})
test('injected silence decodes to zero PCM and Ogg retains every original Opus packet', () => {
  for (const duration of [2.5, 5, 10, 20, 102.5, 1000]) {
    const frames = silenceFrames(duration, 'test')
    const audio = oggOpus(frames)
    const decoded = spawnSync(
      'ffmpeg',
      ['-v', 'error', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'],
      { input: audio },
    )
    assert.equal(decoded.status, 0, decoded.stderr.toString())
    assert.equal(decoded.stdout.length, duration * 16 * 2)
    assert.ok(decoded.stdout.every((byte) => byte === 0))
    const parsed = oggFrames(audio.toString('base64'))
    assert.deepEqual(
      parsed.map((f) => f.data),
      frames.map((f) => f.data),
    )
  }
})

test('nearby audio is not cut just to force a merge that does not reduce the number of chunks', () => {
  const a = record(0, '2026-01-01T00:00:00Z', 12000)
  const b = record(100, '2026-01-01T00:06:00Z', 15000)
  const plans = [...planChunks([recordIndex(a), recordIndex(b)], 600)]
  assert.equal(plans.length, 2)
  assert.deepEqual(
    plans.map((p) => p.durationMs),
    [240000, 300000],
  )
  assert.ok(plans.every((p) => p.ranges.every((r) => r.gapMs === 0)))
})

test('cooperative catalog planning preserves every range while yielding to the UI event loop', async () => {
  const { cooperativePlans } = await import('../src/core/catalog')
  const records = Array.from({ length: 2500 }, (_, i) =>
    recordIndex(
      record(
        i,
        new Date(Date.parse('2026-01-01T00:00:00Z') + Math.floor(i / 50) * 1000).toISOString(),
        1,
      ),
    ),
  ).reverse()
  const original = JSON.stringify(records)
  let ticks = 0
  const timer = setInterval(() => ticks++, 0)
  try {
    const result = await cooperativePlans(records, 60)
    assert.deepEqual(result, [...planChunks(records, 60)])
    assert.equal(JSON.stringify(records), original)
    assert.ok(ticks > 0)
    assert.equal(
      result.reduce((n, p) => n + p.sourceFrames, 0),
      2500,
    )
  } finally {
    clearInterval(timer)
  }
})

test('planning reports monotonic completed work and retains identical chunk boundaries', async () => {
  const { cooperativePlans } = await import('../src/core/catalog')
  const records = Array.from({ length: 2500 }, (_, i) =>
    recordIndex(record(i, new Date(Date.parse('2026-01-01T00:00:00Z') + i * 1000).toISOString())),
  )
  const events: import('../src/core/catalog').PlanningProgress[] = []
  const result = await cooperativePlans(records, 600, false, (event) => events.push({ ...event }))
  assert.deepEqual(result, [...planChunks(records, 600)])
  for (const phase of ['sorting', 'merging', 'grouping', 'planning']) {
    const values = events.filter((event) => event.phase === phase)
    assert.ok(values.length > 0)
    assert.equal(values.at(-1)!.completed, values.at(-1)!.total)
    for (let i = 1; i < values.length; i++)
      assert.ok(values[i].completed >= values[i - 1].completed)
    assert.ok(values.every((event) => event.completed <= event.total))
  }
  assert.equal(events.at(-1)!.chunks, result.length)
})
