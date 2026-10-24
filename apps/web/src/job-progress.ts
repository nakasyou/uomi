export type ProgressDetail = {
  completed?: number
  total?: number
  analyzed_ms?: number
  duration_ms?: number
  bytes_received?: number
  bytes_total?: number
  active?: Array<{
    index: number
    start_ms: number
    end_ms: number
    attempt: number
    state: 'waiting' | 'transcribing' | 'retrying'
  }>
}
export function stageLabel(stage: string, status: string) {
  if (status === 'completed') return 'Completed'
  return (
    (
      {
        queued: 'Waiting in queue',
        downloading: 'Downloading original audio',
        verifying: 'Checking audio integrity',
        decoding: 'Converting audio',
        waiting_analysis: 'Waiting for speech analysis',
        diarizing: 'Detecting speech and speakers',
        waiting_recognition: 'Waiting for transcription capacity',
        waiting_rate_limit: 'Waiting before next Codex request',
        transcribing: 'Transcribing',
        saving: 'Saving transcript',
        retry: 'Waiting to retry',
        failed: 'Failed',
      } as Record<string, string>
    )[stage] ??
    stage ??
    status
  )
}
const clock = (ms: number) => {
  const whole = `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
  const fraction = String(Math.round(ms % 1000))
    .padStart(3, '0')
    .replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}
export function progressLines(detail: ProgressDetail = {}) {
  const lines: string[] = []
  if (detail.total !== undefined)
    lines.push(`${detail.completed ?? 0} / ${detail.total} segments complete`)
  if (detail.analyzed_ms !== undefined && detail.duration_ms !== undefined)
    lines.push(
      `Audio analyzed: ${clock(Math.floor(detail.analyzed_ms / 1000) * 1000)} / ${clock(Math.floor(detail.duration_ms / 1000) * 1000)}`,
    )
  if (detail.bytes_received !== undefined)
    lines.push(
      `Downloaded ${(detail.bytes_received / 1048576).toFixed(1)}${detail.bytes_total ? ` / ${(detail.bytes_total / 1048576).toFixed(1)}` : ''} MB`,
    )
  for (const interval of detail.active ?? [])
    lines.push(
      `Segment ${interval.index}: ${clock(interval.start_ms)}–${clock(interval.end_ms)} · ${interval.state === 'waiting' ? 'waiting for capacity' : interval.state === 'retrying' ? 'retrying' : 'transcribing'}${interval.attempt > 1 ? ` (try ${interval.attempt}/3)` : ''}`,
    )
  return lines
}
