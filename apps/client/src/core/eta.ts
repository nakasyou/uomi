import type { SyncProgress } from './types'

/** Estimates only the current stage, using a rolling minute of observed work. */
export class SyncEta {
  private key = ''
  private samples: { at: number; completed: number }[] = []
  remaining(progress: SyncProgress | null, now: number): number | null {
    if (!progress) {
      this.key = ''
      this.samples = []
      return null
    }
    // Verified chunks cover the whole upload pipeline, rather than just network writes.
    const chunks = progress.chunksTotal !== undefined
    const total = chunks ? progress.chunksTotal! : progress.total
    const completed = chunks ? (progress.chunksCompleted ?? 0) : progress.completed
    const key = `${progress.stage}:${chunks}:${total}`
    const last = this.samples.at(-1)
    if (key !== this.key || (last && (completed < last.completed || now < last.at))) {
      this.key = key
      this.samples = []
    }
    if (!this.samples.length || completed !== this.samples.at(-1)!.completed)
      this.samples.push({ at: now, completed })
    while (this.samples.length > 2 && this.samples[1].at < now - 60000) this.samples.shift()
    if (total <= 0) return null
    if (completed >= total) return 0
    const first = this.samples[0]
    const elapsed = now - first.at
    const processed = completed - first.completed
    if (elapsed < 3000 || processed <= 0) return null
    return ((total - completed) * elapsed) / processed
  }
}

export function etaLabel(ms: number | null): string {
  if (ms === null) return 'Estimating…'
  if (ms < 1000) return 'Almost done'
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 60) return `About ${seconds}s remaining`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `About ${minutes}m remaining`
  return `About ${Math.floor(minutes / 60)}h ${minutes % 60}m remaining`
}
