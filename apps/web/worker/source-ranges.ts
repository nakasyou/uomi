// Keep upload ranges outermost so SQLite seeks (device, prefix, start) for each
// range instead of scanning every saved range against the entire JSON array.
export const overlappingRecordingsSql = `SELECT DISTINCT r.id AS recording_id
  FROM json_each(?) j CROSS JOIN source_ranges s
    ON s.prefix=json_extract(j.value,'$.prefix')
    AND s.start<json_extract(j.value,'$.end')
    AND s.end>json_extract(j.value,'$.start')
  JOIN recordings r ON r.rid=s.recording_id
  WHERE s.device=? LIMIT 9`

export function ranges(frames: { id: string }[]) {
  const out: { prefix: string; start: number; end: number }[] = []
  for (const f of frames) {
    const match = f.id.match(/^(.*\D)(\d+)$/)
    if (!match || match[1].length > 500 || !Number.isSafeInteger(+match[2]))
      throw Error('Invalid source frame identity')
    const index = +match[2],
      last = out.at(-1)
    if (last?.prefix === match[1] && last.end === index) last.end++
    else out.push({ prefix: match[1], start: index, end: index + 1 })
  }
  return out
}
