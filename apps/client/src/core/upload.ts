import { encodeOggUpload } from '@uomi/audio'
import type { AudioManifest } from '@uomi/notion'
import type { AudioSegment } from './segments'

// Keep source identities/timing separate from the already muxed audio.
export function uploadManifest(
  deviceId: string,
  frames: AudioSegment['frames'],
  id: string,
  sha256: string,
): AudioManifest {
  const timing: AudioManifest['timing'] = []
  frames.forEach((f, i) => {
    const last = timing[timing.length - 1]
    if (
      last &&
      last.sequence === f.sequence &&
      last.ringId === f.ringId &&
      last.timestamp === f.recordTimestamp
    )
      last.frames++
    else
      timing.push({
        sequence: f.sequence,
        ringId: f.ringId,
        timestamp: f.recordTimestamp,
        capturedAt: f.capturedAt,
        firstFrame: i,
        frames: 1,
      })
  })
  return {
    schema: 'uomi.notion.v1',
    id,
    deviceId,
    sha256,
    capturedAt: frames[0].capturedAt,
    durationMs: frames.reduce((n, f) => n + f.durationMs, 0),
    frameIds: frames.map((f) => f.id),
    timing,
  }
}

export function uploadBody(manifest: AudioManifest, audio: Uint8Array): string {
  // Base64 is only for the native IPC bridge; native HTTP sends binary bytes.
  return encodeOggUpload(manifest, audio).toString('base64')
}
