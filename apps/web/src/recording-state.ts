/** A response sent before a successful edit cannot roll the visible record back. */
export function mergeRecording<T extends { revision?: number; updated_at?: string }>(
  current: T,
  patch: Partial<T>,
): T {
  if (
    patch.revision !== undefined &&
    current.revision !== undefined &&
    patch.revision < current.revision
  )
    return current
  if (
    patch.revision === current.revision &&
    patch.updated_at &&
    current.updated_at &&
    Date.parse(patch.updated_at) < Date.parse(current.updated_at)
  )
    return current
  return { ...current, ...patch }
}

/** A delayed list response must respect edits confirmed while its request was in flight. */
export function mergeRecordingPage<
  T extends { id: string; revision?: number; updated_at?: string },
>(current: T[], incoming: T[], append = false): T[] {
  const known = new Map(current.map((recording) => [recording.id, recording]))
  const page = incoming.map((recording) =>
    mergeRecording(known.get(recording.id) ?? recording, recording),
  )
  if (!append) return page
  const byId = new Map(page.map((recording) => [recording.id, recording]))
  return [
    ...current.map((recording) => byId.get(recording.id) ?? recording),
    ...page.filter((recording) => !known.has(recording.id)),
  ]
}
