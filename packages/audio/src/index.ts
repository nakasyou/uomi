import { Buffer } from 'buffer'
export interface Frame {
  id: string
  data: string
  durationMs: number
  offsetMs: number
}
export function opusDuration(frame: Buffer): number {
  if (frame.length < 1) throw Error('Empty Opus frame.')
  const config = frame[0] >> 3
  const per =
    config >= 16
      ? 2.5 * (1 << (config & 3))
      : config >= 12
        ? 10 * (1 << (config & 1))
        : [10, 20, 40, 60][config & 3]
  const code = frame[0] & 3
  if (code === 3 && frame.length < 2) throw Error('Truncated Opus frame.')
  const n = code === 0 ? 1 : code === 3 ? frame[1] & 63 : 2
  const duration = per * n
  if (n < 1 || duration > 120) throw Error('Invalid Opus packet duration.')
  return duration
}

// Ogg CRC uses the non-reflected polynomial (not the ZIP CRC32 variant).
function crc(bytes: Buffer): number {
  let value = 0
  for (const byte of bytes) {
    value ^= byte << 24
    for (let bit = 0; bit < 8; bit++) value = (value << 1) ^ (value & 0x80000000 ? 0x04c11db7 : 0)
  }
  return value >>> 0
}
export function oggOpus(frames: Frame[]): Buffer {
  if (!frames.length) throw Error('This recording contains no audio.')
  let sequence = 0
  const page = (packet: Buffer, granule: number, flags: number) => {
    const segments = Math.floor(packet.length / 255) + 1
    if (segments > 255) throw Error('Audio packet is too large.')
    const header = Buffer.alloc(27 + segments)
    header.write('OggS')
    header[5] = flags
    header.writeBigUInt64LE(BigInt(granule), 6)
    header.writeUInt32LE(1, 14)
    header.writeUInt32LE(sequence++, 18)
    header[26] = segments
    for (let i = 0; i < segments; i++) header[27 + i] = Math.min(255, packet.length - i * 255)
    const bytes = Buffer.concat([header, packet])
    bytes.writeUInt32LE(crc(bytes), 22)
    return bytes
  }
  const head = Buffer.alloc(19)
  head.write('OpusHead')
  head[8] = 1
  head[9] = 1
  head.writeUInt32LE(16000, 12)
  // Original raw frames do not carry encoder pre-skip; preserve all samples.
  const tags = Buffer.alloc(16)
  tags.write('OpusTags')
  const pages = [page(head, 0, 2), page(tags, 0, 0)]
  let granule = 0
  frames.forEach((frame, i) => {
    const packet = Buffer.from(frame.data, 'base64')
    granule += opusDuration(packet) * 48
    pages.push(page(packet, granule, i === frames.length - 1 ? 4 : 0))
  })
  return Buffer.concat(pages)
}

export function oggFrames(input: string | Uint8Array): Frame[] {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'base64') : Buffer.from(input)
  const frames: Frame[] = []
  let pending: Buffer[] = []
  let offset = 0
  let position = 0
  while (position < bytes.length) {
    if (bytes.toString('ascii', position, position + 4) !== 'OggS' || position + 27 > bytes.length)
      throw Error('Invalid saved Ogg audio.')
    const count = bytes[position + 26]
    let body = position + 27 + count
    if (body > bytes.length) throw Error('Truncated saved Ogg audio.')
    for (let i = 0; i < count; i++) {
      const size = bytes[position + 27 + i]
      if (body + size > bytes.length) throw Error('Truncated saved Opus packet.')
      pending.push(bytes.subarray(body, body + size))
      body += size
      if (size < 255) {
        const packet = Buffer.concat(pending)
        pending = []
        const signature = packet.toString('ascii', 0, 8)
        if (signature === 'OpusHead' || signature === 'OpusTags') continue
        const durationMs = opusDuration(packet)
        frames.push({
          id: `remote:${frames.length}`,
          data: packet.toString('base64'),
          durationMs,
          offsetMs: offset,
        })
        offset += durationMs
      }
    }
    position = body
  }
  if (pending.length || !frames.length) throw Error('Saved Opus audio is incomplete.')
  return frames
}

export function stripSyntheticGaps(
  audio: Uint8Array,
  gaps: { beforeFrame: number; durationMs: number }[] | undefined,
  sourceFrameCount: number,
): Uint8Array {
  if (!gaps?.length) return audio
  const packets = oggFrames(audio)
  const byFrame = new Map(gaps.map((gap) => [gap.beforeFrame, gap.durationMs]))
  const frames: Frame[] = []
  let cursor = 0
  for (let i = 0; i < sourceFrameCount; i++) {
    let remaining = byFrame.get(i) ?? 0
    while (remaining > 0) {
      const packet = packets[cursor++]
      if (!packet || packet.durationMs > remaining)
        throw Error('Synthetic gap duration does not match saved audio.')
      remaining -= packet.durationMs
    }
    const packet = packets[cursor++]
    if (!packet) throw Error('Saved audio is missing original packets.')
    frames.push(packet)
  }
  if (cursor !== packets.length) throw Error('Saved audio contains unexpected packets.')
  return oggOpus(frames)
}
