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
  if (out.length > 1500) throw Error('Too many source ranges; use shorter chunks')
  return out
}
