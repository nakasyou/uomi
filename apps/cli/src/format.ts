import { CliError } from './errors.ts'

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

export interface Segment {
  start_ms?: number
  speaker?: string
  text?: string
}

export function segmentLines(segments: Segment[]): string[] {
  const hourMode = segments.some((segment) => Number(segment.start_ms ?? 0) >= 3600000)
  return segments.map((segment) => {
    let timestamp = formatClock(Number(segment.start_ms ?? 0))
    if (!hourMode) timestamp = timestamp.padStart(5, '0')
    return `[${timestamp}] ${segment.speaker || '-'}: ${segment.text ?? ''}`
  })
}

export function parseTime(value: string, name: string, now: number): number {
  const raw = value.trim()
  const relative = raw.match(/^(\d+)([smhdw])$/)
  if (relative) {
    const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[
      relative[2] as 's' | 'm' | 'h' | 'd' | 'w'
    ]
    return now - Number(relative[1]) * unit
  }
  if (/^\d+$/.test(raw)) {
    const epoch = Number(raw)
    if (Number.isSafeInteger(epoch)) return epoch
  }
  const local = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/,
  )
  if (local) {
    const [, y, mo, d, h = '0', mi = '0', sec = '0', frac = '0'] = local
    const date = new Date(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(sec),
      Number(frac.padEnd(3, '0')),
    )
    if (
      date.getFullYear() === Number(y) &&
      date.getMonth() === Number(mo) - 1 &&
      date.getDate() === Number(d) &&
      date.getHours() === Number(h) &&
      date.getMinutes() === Number(mi)
    )
      return date.getTime()
  } else if (
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)
  ) {
    const parsed = Date.parse(raw.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
    if (Number.isFinite(parsed)) return parsed
  }
  throw new CliError(
    `--${name} must be an ISO 8601 time, epoch milliseconds or a relative age like 30m, 2h or 1d`,
  )
}
