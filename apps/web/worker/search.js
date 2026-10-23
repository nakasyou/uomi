// Search-only normalization. Canonical transcripts and display offsets stay untouched.
export function normalizeSearch(value) {
  return value.normalize('NFKC').toLowerCase()
    .replace(/[\u30a1-\u30f6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .normalize('NFC').replace(/[\s\u200b\ufeff]+/gu, '')
}
export function searchCondition(input, alias = 'r') {
  if (typeof input !== 'string' || input.length > 200) throw Error('Search needs 2–200 characters')
  const query = normalizeSearch(input)
  if ([...query].length < 2) throw Error('Search needs at least 2 non-space characters')
  if ([...query].length === 2) return {
    join: '', sql: `${alias}.search_text LIKE ? ESCAPE '\\'`,
    values: ['%' + query.replace(/[\\%_]/g, c => '\\' + c) + '%'],
  }
  const chars = [...query]
  const grams = [...new Set(chars.slice(0, -2).map((_, i) => chars.slice(i, i + 3).join('')))]
  return {
    join: ` JOIN transcripts ON transcripts.rowid=${alias}.rid`,
    sql: `(transcripts MATCH ? AND instr(${alias}.search_text,?)>0)`,
    values: [grams.map(g => '"' + g.replaceAll('"', '""') + '"').join(' AND '), query],
  }
}
