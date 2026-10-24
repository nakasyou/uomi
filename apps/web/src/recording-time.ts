const zone = 'Asia/Tokyo'
export function recordingStart(value: number | null) {
  if (value == null || !Number.isFinite(value)) return 'Untimed recording'
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(value)
    .replaceAll('-', '/')
}
export function recordingTitle(recording: { title: string; recorded_at: number | null }) {
  const automatic =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(recording.title) &&
    Number.isFinite(Date.parse(recording.title))
  return recording.title && !automatic
    ? recording.title
    : recordingStart(recording.recorded_at ?? (automatic ? Date.parse(recording.title) : null))
}
export const recordingDate = (value: number | null) =>
  value == null
    ? 'Unknown date'
    : new Intl.DateTimeFormat('ja-JP', {
        timeZone: zone,
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }).format(value)
export const japanTime = (value: number) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(value)
