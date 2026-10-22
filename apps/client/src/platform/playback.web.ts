import type { Frame } from '../core/types'
import { muxAudio } from './mux'
let generation = 0
let cleanup: (() => void) | undefined
export function stopPlayback() {
  generation++
  cleanup?.()
}
export async function playAudio(frames: Frame[]): Promise<void> {
  stopPlayback()
  const request = generation
  const bytes = await muxAudio(frames)
  if (request !== generation) return
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(bytes)], {
      type: 'audio/ogg; codecs=opus',
    }),
  )
  const audio = new Audio(url)
  await new Promise<void>((resolve, reject) => {
    let finished = false
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      audio.onended = null
      audio.onerror = null
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      URL.revokeObjectURL(url)
      if (cleanup === stop) cleanup = undefined
      if (error) reject(error)
      else resolve()
    }
    const stop = () => {
      audio.onended = null
      audio.onerror = null
      finish()
    }
    cleanup = stop
    audio.onended = () => finish()
    audio.onerror = () =>
      finish(
        Error('Audio could not be played. Check that your Linux media codecs support Ogg Opus.'),
      )
    void audio.play().catch((e) => finish(e instanceof Error ? e : Error(String(e))))
  })
}
