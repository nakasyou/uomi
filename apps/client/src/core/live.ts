import { Buffer } from 'buffer'
import { opusDuration } from './protocol'
import type { Frame } from './types'

// Notification sequence increments for every fragment; fragment index restarts
// at zero for each Opus packet. The next zero marks completion of the previous.
export class LiveAssembler {
  private parts: Buffer[] = []
  private last: number | undefined
  private index = -1
  dropped = 0
  push(bytes: Buffer): Frame | null {
    if (bytes.length < 4) {
      this.parts = []
      this.index = -1
      this.dropped++
      return null
    }
    const sequence = bytes.readUInt16LE(0)
    const index = bytes[2]
    const contiguous = this.last === undefined || sequence === ((this.last + 1) & 65535)
    this.last = sequence
    let completed: Frame | null = null
    if (!contiguous) {
      this.parts = []
      this.index = -1
      this.dropped++
    }
    if (index === 0) {
      if (this.parts.length) {
        const packet = Buffer.concat(this.parts)
        completed = {
          id: `live:${sequence}`,
          data: packet.toString('base64'),
          durationMs: opusDuration(packet),
          offsetMs: 0,
        }
      }
      this.parts = [bytes.subarray(3)]
      this.index = 0
    } else if (this.parts.length && index === this.index + 1) {
      this.parts.push(bytes.subarray(3))
      this.index = index
      if (this.parts.reduce((n, p) => n + p.length, 0) > 8192) {
        this.parts = []
        this.index = -1
        this.dropped++
      }
    } else {
      this.parts = []
      this.index = -1
      this.dropped++
    }
    return completed
  }
}
