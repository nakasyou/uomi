import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'buffer'
import { oggOpus } from '../src/core/playback'
const frame = {
  id: 'frame',
  data: Buffer.from([0x98, 1]).toString('base64'),
  durationMs: 20,
  offsetMs: 0,
}
test('Ogg playback writes headers, checksums, sequence and 48 kHz granules', () => {
  const audio = oggOpus([frame, frame])
  let offset = 0
  const pages: Buffer[] = []
  while (offset < audio.length) {
    assert.equal(audio.toString('ascii', offset, offset + 4), 'OggS')
    const segmentCount = audio[offset + 26]
    const payloadLength = audio
      .subarray(offset + 27, offset + 27 + segmentCount)
      .reduce((a, b) => a + b, 0)
    const page = audio.subarray(offset, offset + 27 + segmentCount + payloadLength)
    let crc = 0
    for (let i = 0; i < page.length; i++) {
      crc ^= (i >= 22 && i < 26 ? 0 : page[i]) << 24
      for (let b = 0; b < 8; b++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1
    }
    assert.equal(page.readUInt32LE(22), crc >>> 0)
    assert.equal(page.readUInt32LE(18), pages.length)
    pages.push(page)
    offset += page.length
  }
  assert.equal(pages.length, 4)
  assert.equal(pages[0][5], 2)
  assert.equal(pages[0].subarray(28, 36).toString(), 'OpusHead')
  assert.equal(pages[3][5], 4)
  assert.equal(pages[3].readBigUInt64LE(6), 1920n)
  assert.throws(() => oggOpus([]), /no audio/)
})
