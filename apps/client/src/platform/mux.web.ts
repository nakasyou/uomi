import { workerSlot } from './worker-slot.web'
import type { Frame } from '../core/types'
// Preparation has at most two jobs, so at most two workers exist. Transfer the
// result instead of cloning the Ogg bytes back onto the UI thread.
export function muxAudio(frames: Frame[]): Promise<Uint8Array> {
  return workerSlot(() => runWorker(frames))
}
function runWorker(frames: Frame[]): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./ogg.worker.ts', import.meta.url), { type: 'module' })
    const fail = (error: unknown) => {
      clearTimeout(timer)
      worker.terminate()
      reject(error)
    }
    const timer = setTimeout(
      () => fail(Error('Audio preparation timed out. Local audio is retained.')),
      120000,
    )
    worker.onmessage = (event) => {
      clearTimeout(timer)
      worker.terminate()
      if (event.data.error) reject(Error(event.data.error))
      else resolve(event.data.audio)
    }
    worker.onerror = () => fail(Error('Audio worker failed. Local audio is retained.'))
    worker.onmessageerror = () => fail(Error('Audio worker returned an invalid result.'))
    try {
      worker.postMessage(frames.map(({ data, durationMs }) => ({ data, durationMs })))
    } catch (error) {
      fail(error)
    }
  })
}
