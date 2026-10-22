import type { Frame } from '../core/types'
import { oggOpus } from '../core/playback'
export async function startLiveAudio(onError: (error: Error) => void) {
  const context = new AudioContext({ latencyHint: 'interactive' })
  try {
    await context.resume()
  } catch (error) {
    await context.close()
    throw error
  }
  let active = true
  let frames: Frame[] = []
  let ms = 0
  let decoding = false
  let next = 0
  const sources = new Set<AudioBufferSourceNode>()
  const decode = async () => {
    if (decoding || !active || ms < 240) return
    const batch = frames
    frames = []
    ms = 0
    decoding = true
    try {
      const bytes = new Uint8Array(oggOpus(batch))
      const buffer = await context.decodeAudioData(bytes.buffer)
      if (!active) return
      // Bounded jitter queue: drop latency rather than accumulate old audio.
      if (next - context.currentTime > 1) return
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      sources.add(source)
      source.onended = () => {
        sources.delete(source)
        source.disconnect()
      }
      next = Math.max(next, context.currentTime + 0.04)
      source.start(next)
      next += buffer.duration
    } catch (error) {
      if (active) onError(error instanceof Error ? error : Error(String(error)))
    } finally {
      decoding = false
      if (active) void decode()
    }
  }
  return {
    push(frame: Frame) {
      if (!active) return
      frames.push(frame)
      ms += frame.durationMs
      if (ms > 1000) {
        frames = [frame]
        ms = frame.durationMs
      }
      void decode()
    },
    stop() {
      active = false
      frames = []
      for (const source of sources) {
        source.onended = null
        source.stop()
        source.disconnect()
      }
      sources.clear()
      void context.close()
    },
  }
}
