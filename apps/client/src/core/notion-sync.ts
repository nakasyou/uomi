import type { RecordIndex } from './catalog'

// Native mirror queries include a 15-minute look-behind for overlapping pages.
// Merge those expanded windows to avoid scanning the same time range twice.
export function reconciliationQueries(records: RecordIndex[]) {
  const devices = new Map<string, RecordIndex[]>()
  for (const record of records) {
    const group = devices.get(record.deviceId) ?? []
    group.push(record)
    devices.set(record.deviceId, group)
  }
  const queries: { devices: string[]; from?: number; until?: number }[] = []
  for (const [device, group] of devices) {
    if (group.some((record) => !Number.isFinite(Date.parse(record.capturedAt ?? '')))) {
      queries.push({ devices: [device] })
      continue
    }
    const windows = group
      .map((record) => ({
        from: Date.parse(record.capturedAt!),
        until: Date.parse(record.capturedAt!) + record.durationMs,
      }))
      .sort((a, b) => a.from - b.from)
    let current: { from: number; until: number } | undefined
    for (const window of windows) {
      if (current && window.from - 900000 <= current.until) {
        current.until = Math.max(current.until, window.until)
      } else {
        current = { ...window }
        queries.push({ devices: [device], ...current })
      }
      // Keep the emitted query synchronized with the merged window.
      queries[queries.length - 1].until = current.until
    }
  }
  return queries
}
