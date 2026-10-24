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
