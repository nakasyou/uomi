import { Buffer } from 'buffer'
export const DEFAULT_MIC_GAIN = 6
export const MIC_GAIN_LABELS = [
  'Mute',
  '−20 dB',
  '−10 dB',
  '0 dB',
  '+6 dB',
  '+10 dB',
  '+20 dB',
  '+30 dB',
  '+40 dB',
] as const
export const UUID = {
  settings: '19b10010-e8f2-537e-4f6c-d104768a1214',
  micGain: '19b10012-e8f2-537e-4f6c-d104768a1214',
  audio: '19b10001-e8f2-537e-4f6c-d104768a1214',
  omi: '19b10000-e8f2-537e-4f6c-d104768a1214',
  codec: '19b10002-e8f2-537e-4f6c-d104768a1214',
  storage: '30295780-4301-eabd-2904-2849adfeae43',
  control: '30295781-4301-eabd-2904-2849adfeae43',
  status: '30295782-4301-eabd-2904-2849adfeae43',
  time: '19b10030-e8f2-537e-4f6c-d104768a1214',
  clock: '19b10031-e8f2-537e-4f6c-d104768a1214',
  info: '0000180a-0000-1000-8000-00805f9b34fb',
  serial: '00002a25-0000-1000-8000-00805f9b34fb',
  firmware: '00002a26-0000-1000-8000-00805f9b34fb',
  batteryService: '0000180f-0000-1000-8000-00805f9b34fb',
  battery: '00002a19-0000-1000-8000-00805f9b34fb',
}
export interface RingInfo {
  read: bigint
  write: bigint
  dropped: bigint
  packetSize: number
  ringId: bigint | null
  caps: number
  contract: number
}
export function parseInfo(b: Buffer): RingInfo {
  if (b.length < 31 || b[0] !== 2) throw Error('Invalid Omi ring information.')
  const packetSize = b.readUInt16BE(29)
  if (packetSize !== 444) throw Error(`Unsupported ring packet size: ${packetSize}.`)
  return {
    caps: b.length >= 32 ? b[31] : 0,
    contract: b.length >= 33 ? b[32] : 0,
    read: b.readBigUInt64BE(1),
    write: b.readBigUInt64BE(9),
    dropped: b.readBigUInt64BE(21),
    packetSize,
    ringId: b.length >= 41 ? b.readBigUInt64BE(33) : null,
  }
}
export function readCommand(start: bigint, count: number): Buffer {
  const b = Buffer.alloc(13)
  b[0] = 0x11
  b.writeBigUInt64BE(start, 1)
  b.writeUInt32BE(count, 9)
  return b
}
export { opusDuration } from '@uomi/audio'
export function parseRecord(record: Buffer): {
  timestampRaw: number
  frames: Buffer[]
} {
  if (record.length !== 444) throw Error('Truncated Omi ring record.')
  const frames: Buffer[] = []
  for (let i = 4; i < 443;) {
    const n = record[i]
    if (n === 0) {
      i++
      continue
    }
    if (i + 1 + n >= 444) break
    frames.push(record.subarray(i + 1, i + 1 + n))
    i += n + 1
  }
  return { timestampRaw: record.readUInt32BE(0), frames }
}
export class RecordAssembler {
  private buffer = Buffer.alloc(0)
  push(chunk: Buffer): Buffer[] {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const out: Buffer[] = []
    while (this.buffer.length >= 444) {
      out.push(this.buffer.subarray(0, 444))
      this.buffer = this.buffer.subarray(444)
    }
    return out
  }
  get remaining() {
    return this.buffer.length
  }
}
