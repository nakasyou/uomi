/** Own every subprocess and bound its diagnostics; never leave an encoder after lease loss. */
export async function audioProcess(
  command: string[],
  signal: AbortSignal,
  timeoutMs = 120000,
  onProgress?: (progress: number) => void,
) {
  signal.throwIfAborted()
  const process = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' })
  let output = ''
  let diagnostic = '',
    pending = '',
    timedOut = false
  let forceKill: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    process.kill('SIGTERM')
    forceKill ??= setTimeout(() => process.kill('SIGKILL'), 5000)
  }
  const timeout = setTimeout(() => {
    timedOut = true
    stop()
  }, timeoutMs)
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  const consume = async (stream: ReadableStream<Uint8Array>, progress: boolean) => {
    const reader = stream.getReader(),
      decoder = new TextDecoder()
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        const text = decoder.decode(next.value, { stream: true })
        diagnostic = (diagnostic + text).slice(-4000)
        if (progress) output = (output + text).slice(-4000)
        if (progress && onProgress) {
          pending = (pending + text).slice(-8192)
          let newline: number
          while ((newline = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, newline)
            pending = pending.slice(newline + 1)
            try {
              const value = JSON.parse(line)
              if (typeof value.progress === 'number' && Number.isFinite(value.progress))
                onProgress(Math.max(0, Math.min(1, value.progress)))
            } catch {
              /* SDK logs may accompany JSON progress on stdout. */
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
  try {
    const [, , code] = await Promise.all([
      consume(process.stdout, true),
      consume(process.stderr, false),
      process.exited,
    ])
    signal.throwIfAborted()
    if (timedOut) throw Error(`${command[0]} exceeded ${Math.round(timeoutMs / 1000)} seconds`)
    if (code !== 0) throw Error(`${command[0]} exited ${code}: ${diagnostic}`)
    return output
  } finally {
    clearTimeout(timeout)
    if (forceKill) clearTimeout(forceKill)
    signal.removeEventListener('abort', stop)
    if (process.exitCode === null) {
      process.kill('SIGKILL')
      await process.exited
    }
  }
}

/** Abort-aware shared capacity, including requests belonging to different recordings. */
export class WorkSlots {
  private active = 0
  private waiters: (() => void)[] = []
  constructor(private readonly maximum: number) {}
  get status() {
    return { active: this.active, waiting: this.waiters.length, maximum: this.maximum }
  }
  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    if (this.active < this.maximum) this.active++
    else
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          signal.removeEventListener('abort', abort)
          resolve()
        }
        const abort = () => {
          this.waiters = this.waiters.filter((waiter) => waiter !== ready)
          reject(signal.reason)
        }
        this.waiters.push(ready)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    try {
      signal.throwIfAborted()
      return await work()
    } finally {
      const next = this.waiters.shift()
      if (next) next()
      else this.active--
    }
  }
}
