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
