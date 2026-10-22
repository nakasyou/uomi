import { oggOpus } from '../core/playback'
import type { Frame } from '../core/types'
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Frame[]>) => void) | null
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}
scope.onmessage = (event) => {
  try {
    const audio = new Uint8Array(oggOpus(event.data))
    scope.postMessage({ audio }, [audio.buffer])
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
