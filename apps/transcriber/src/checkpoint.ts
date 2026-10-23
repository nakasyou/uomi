import { randomUUID } from 'node:crypto'
import { writeFile, rename, rm } from 'node:fs/promises'

/** Concurrent or abandoned leases must never share an intermediate checkpoint file. */
export async function saveCheckpoint(path: string, value: unknown, signal: AbortSignal) {
  signal.throwIfAborted()
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
    signal.throwIfAborted()
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch((error) => {
      console.error(JSON.stringify({ stage: 'checkpoint_cleanup', error: String(error) }))
    })
  }
}
