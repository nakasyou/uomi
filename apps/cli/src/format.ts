export function formatLocal(ms: number | null | undefined): string {
  if (!ms) return '?'
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatDuration(ms: number | null | undefined): string {
  const seconds = Math.max(0, Math.floor((ms ?? 0) / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  if (hours) return `${hours}h ${minutes}m ${rest}s`
  if (minutes) return `${minutes}m ${rest}s`
  return `${rest}s`
}

export function formatClock(ms: number | null | undefined): string {
  const seconds = Math.floor((ms ?? 0) / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  if (hours) return `${hours}:${pad(minutes)}:${pad(rest)}`
  return `${pad(minutes)}:${pad(rest)}`
}

export function firstLine(text: string | null | undefined, width = 80): string {
  for (const rawLine of (text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    return line.length <= width ? line : `${line.slice(0, width - 1)}…`
  }
  return ''
}

export function formatPercent(progress: number | null | undefined): string {
  if (typeof progress !== 'number' || !Number.isFinite(progress)) return '?'
  return `${Math.round(progress * 100)}%`
}

export function formatDetail(detail: unknown): string {
  if (!detail || typeof detail !== 'object') return ''
  const value = detail as Record<string, unknown>
  const parts: string[] = []
  for (const key of ['completed', 'total', 'active']) {
    if (value[key] === undefined) continue
    if (key === 'active' && Array.isArray(value.active)) parts.push(`active=${value.active.length}`)
    else parts.push(`${key}=${String(value[key])}`)
  }
  return parts.join(' ')
}
