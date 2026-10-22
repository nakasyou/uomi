import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'buffer'
import { LiveAssembler } from '../src/core/live'
function notification(seq: number, index: number, payload: number[]) {
  const b = Buffer.from([0, 0, index, ...payload])
  b.writeUInt16LE(seq, 0)
  return b
}
test('live fragments reassemble into Opus frames across notification counter wrap', () => {
  const a = new LiveAssembler()
  assert.equal(a.push(notification(65534, 0, [0x98])), null)
  assert.equal(a.push(notification(65535, 1, [1, 2])), null)
  const frame = a.push(notification(0, 0, [0x98, 3]))
  assert.deepEqual(Buffer.from(frame!.data, 'base64'), Buffer.from([0x98, 1, 2]))
  assert.equal(frame!.durationMs, 20)
  assert.equal(a.dropped, 0)
})
test('live notification loss discards partial packets and resynchronizes', () => {
  const a = new LiveAssembler()
  a.push(notification(0, 0, [0x98]))
  assert.equal(a.push(notification(2, 1, [1])), null)
  assert.equal(a.push(notification(3, 0, [0x98, 2])), null)
  assert.equal(a.push(notification(4, 0, [0x98, 3]))!.durationMs, 20)
  assert.ok(a.dropped > 0)
})
test('malformed and orphaned live notifications never produce fake audio', () => {
  const a = new LiveAssembler()
  assert.equal(a.push(Buffer.from([1])), null)
  assert.equal(a.push(notification(1, 2, [0x98, 1])), null)
  assert.equal(a.push(notification(2, 0, [0x98, 1])), null)
  assert.ok(a.push(notification(3, 0, [0x98, 1])))
})
