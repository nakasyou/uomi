import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'buffer'
import {
  parseInfo,
  parseRecord,
  RecordAssembler,
  readCommand,
  opusDuration,
} from '../src/core/protocol'
import { segments, periodicDue } from '../src/core/segments'
import { defaults, validateSettings, type Recording } from '../src/core/types'
test('ring INFO preserves 64-bit counters and ring identity', () => {
  const b = Buffer.alloc(41)
  b[0] = 2
  b.writeBigUInt64BE(2n ** 60n, 1)
  b.writeBigUInt64BE(2n ** 60n + 2n, 9)
  b.writeUInt16BE(444, 29)
  b.writeBigUInt64BE(123n, 33)
  assert.equal(parseInfo(b).read, 2n ** 60n)
  assert.equal(parseInfo(b).ringId, 123n)
  assert.throws(() => parseInfo(b.subarray(0, 30)))
})
test('read command is big-endian, bounded, and lossless', () => {
  const b = readCommand(2n ** 60n, 128)
  assert.equal(b.readBigUInt64BE(1), 2n ** 60n)
  assert.equal(b.readUInt32BE(9), 128)
})
test('unaligned notifications reassemble multiple complete records', () => {
  const b = Buffer.alloc(444 * 3, 12)
  const a = new RecordAssembler()
  assert.equal(a.push(b.subarray(0, 70)).length, 0)
  assert.equal(a.push(b.subarray(70, 1000)).length, 2)
  assert.equal(a.remaining, 112)
  assert.equal(a.push(b.subarray(1000)).length, 1)
  assert.equal(a.remaining, 0)
})
test('upstream padding and trailing overflow marker are respected', () => {
  const b = Buffer.alloc(444)
  b.writeUInt32BE(1750000000)
  b[4] = 2
  b[5] = 0x98
  b[6] = 42
  b[440] = 3
  b[441] = 99
  b[442] = 99
  b[443] = 99
  assert.equal(parseRecord(b).frames.length, 1)
  assert.equal(parseRecord(b).timestampRaw, 1750000000)
})
test('Opus TOC duration handles SILK, CELT and variable count', () => {
  assert.equal(opusDuration(Buffer.from([0])), 10)
  assert.equal(opusDuration(Buffer.from([0x98])), 20)
  assert.equal(opusDuration(Buffer.from([0x83, 3])), 7.5)
  assert.throws(() => opusDuration(Buffer.from([0x83])))
  assert.throws(() => opusDuration(Buffer.from([0x9b, 63])))
})
function record(): Recording {
  return {
    key: 'record:x',
    deviceId: 'serial',
    ringId: '123',
    sequence: '1',
    capturedAt: '2026-01-01T00:00:00.000Z',
    timestampRaw: 1767225600,
    timing: 'device-utc',
    frames: Array.from({ length: 150 }, (_, i) => ({
      id: `f:${i}`,
      data: 'mA==',
      durationMs: 20,
      offsetMs: i * 20,
    })),
    uploaded: 0,
    bytes: 444,
    receivedAt: '2026-01-01T00:00:00Z',
  }
}
test('segment maximum is strict and partial tail is retained', () => {
  const all = [...segments([record()], 1)]
  assert.deepEqual(
    all.map((s) => s.durationMs),
    [1000, 1000, 1000],
  )
  assert.equal(all[1].frames[0].capturedAt, '2026-01-01T00:00:01.000Z')
  assert.equal(new Set(all.flatMap((s) => s.frames.map((f) => f.id))).size, 150)
})
test('changing segment size never changes canonical frame identity', () => {
  assert.deepEqual(
    [...segments([record()], 1)].flatMap((s) => s.frames.map((f) => f.id)),
    [...segments([record()], 30)].flatMap((s) => s.frames.map((f) => f.id)),
  )
})
test('partial delivery resumes from first unsent frame and uptime stays uncertain', () => {
  const r = record()
  r.uploaded = 79
  r.capturedAt = null
  r.timing = 'device-uptime'
  const out = [...segments([r], 1)]
  assert.equal(out[0].frames[0].id, 'f:79')
  assert.equal(out[0].frames[0].capturedAt, null)
  assert.deepEqual(
    out.map((s) => s.durationMs),
    [420, 1000],
  )
})
test('periodic threshold uses successful sync time', () => {
  const now = Date.now()
  assert.equal(periodicDue(null, 6, now), true)
  assert.equal(periodicDue(new Date(now - 5 * 3600000).toISOString(), 6, now), false)
  assert.equal(periodicDue(new Date(now - 6 * 3600000).toISOString(), 6, now), true)
})
test('settings reject unsafe URL/header and invalid numeric boundaries', () => {
  validateSettings(defaults)
  for (const bad of [
    { endpoint: 'http://example.com' },
    { secretHeader: 'Content-Type' },
    { secretHeader: 'X-Foo\r\nInjected' },
    { segmentSeconds: 0 },
    { segmentSeconds: 1.5 },
    { intervalHours: NaN },
    { mode: 'realtime' },
  ])
    assert.throws(() => validateSettings({ ...defaults, ...bad } as typeof defaults))
})
