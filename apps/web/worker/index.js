const VERSION = '2026-07-28'
const json = (data, status = 200) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } })
const plain = (values) => (values ?? []).map((v) => v.plain_text ?? v.text?.content ?? '').join('')
const object = (properties) => ({
  type: 'object',
  properties,
  additionalProperties: false,
})
const tools = [
  {
    name: 'search_transcripts',
    description:
      'Search the local Uomi full-text index. Literal substring, case-insensitive. Optional recording overlap range uses ISO-8601 timestamps with timezone. Results are recording-level, not word-level. Check index_status for freshness; sync_index advances a bounded page.',
    inputSchema: object({
      query: { type: 'string', minLength: 3, maxLength: 200 },
      from: { type: 'string' },
      to: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      cursor: { type: 'string' },
    }),
  },
  {
    name: 'recordings_in_range',
    description:
      'List recordings overlapping [from,to), ordered by recording start. Returns bounded text previews and a continuation cursor.',
    inputSchema: {
      ...object({
        from: { type: 'string' },
        to: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        cursor: { type: 'string' },
      }),
      required: ['from', 'to'],
    },
  },
  {
    name: 'read_transcript',
    description:
      'Read a bounded slice of one indexed transcript. Offset is a JavaScript UTF-16 text offset, not an audio timestamp.',
    inputSchema: {
      ...object({
        id: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        length: { type: 'integer', minimum: 1, maximum: 16000 },
      }),
      required: ['id'],
    },
  },
  {
    name: 'index_status',
    description: 'Report index size, source configuration, sync progress and freshness.',
    inputSchema: object({}),
  },
  {
    name: 'sync_index',
    description:
      'Rebuild or refresh persistent metadata and audio caches from Notion, one recording per call. Repeat until has_more=false. Writes only the derived index, never Notion.',
    inputSchema: object({}),
  },
].map((t) => ({
  ...t,
  annotations: {
    readOnlyHint: t.name !== 'sync_index',
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: t.name === 'sync_index',
  },
}))
tools[0].inputSchema.required = ['query']
export function time(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw Error('Use an ISO-8601 timestamp with timezone.')
  return Date.parse(value)
}
function integer(v, fallback, min, max) {
  if (v === undefined) return fallback
  if (!Number.isInteger(v) || v < min || v > max) throw Error('Invalid integer argument.')
  return v
}
export function searchPlan(a) {
  const limit = integer(a.limit, 20, 1, 50),
    clauses = [],
    args = []
  if (a.from !== undefined) {
    clauses.push('r.finished_at > ?')
    args.push(time(a.from))
  }
  if (a.to !== undefined) {
    clauses.push('r.recorded_at < ?')
    args.push(time(a.to))
  }
  if (a.from !== undefined && a.to !== undefined && time(a.from) >= time(a.to))
    throw Error('from must precede to.')
  let join = ''
  if (a.query !== undefined) {
    if (typeof a.query !== 'string' || [...a.query].length < 3 || a.query.length > 200)
      throw Error('query must be 3–200 characters.')
    join = ' JOIN transcripts ON transcripts.id=r.id'
    clauses.push('transcripts MATCH ?')
    args.push('\"' + a.query.replaceAll('\"', '\"\"') + '\"')
  }
  if (a.cursor) {
    let c
    try {
      c = JSON.parse(atob(a.cursor))
    } catch {
      throw Error('Invalid cursor.')
    }
    if ((c.time !== null && !Number.isFinite(c.time)) || typeof c.id !== 'string')
      throw Error('Invalid cursor.')
    if (c.time === null) {
      clauses.push('((r.recorded_at IS NULL AND r.id > ?) OR r.recorded_at IS NOT NULL)')
      args.push(c.id)
    } else {
      clauses.push('(r.recorded_at > ? OR (r.recorded_at = ? AND r.id > ?))')
      args.push(c.time, c.time, c.id)
    }
  }
  return {
    sql: `SELECT r.id,r.recorded_at,r.finished_at,r.device,r.status,r.url,substr(r.text,1,1200) AS preview FROM recordings r${join} ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY r.recorded_at,r.id LIMIT ?`,
    args: [...args, limit + 1],
    limit,
  }
}
async function notion(env, path, body) {
  const res = await fetch('https://api.notion.com/v1' + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2025-09-03',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok)
    throw Error(
      `Notion HTTP ${res.status}; retry later${res.headers.get('retry-after') ? ' (Retry-After ' + res.headers.get('retry-after') + ')' : ''}.`,
    )
  return res.json()
}
async function boundedJson(response, max = 512 * 1024) {
  if (!response.ok) throw Error('Transcript download failed.')
  const reader = response.body.getReader()
  let size = 0,
    parts = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > max) throw Error('Transcript exceeds 512 KiB index limit.')
      parts.push(value)
    }
  } finally {
    await reader.cancel()
  }
  const out = new Uint8Array(size)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return JSON.parse(new TextDecoder().decode(out))
}
async function sync(env) {
  if (!env.NOTION_TOKEN || !env.NOTION_DATA_SOURCE_ID)
    throw Error('Configure NOTION_TOKEN and NOTION_DATA_SOURCE_ID in Sites runtime secrets.')
  const now = Date.now()
  const lock = await env.DB.prepare(
    'UPDATE sync_state SET lease_until=? WHERE id=1 AND lease_until < ?',
  )
    .bind(now + 300000, now)
    .run()
  if (!lock.meta.changes) throw Error('Index sync is already running; retry later.')
  try {
    const state = await env.DB.prepare('SELECT * FROM sync_state WHERE id=1').first()
    const cycle = state.cycle_start ?? new Date(now).toISOString()
    if (state.scanned >= 9990)
      throw Error(
        'Notion query is approaching its 10,000-result ceiling. Partitioned backfill is required; coverage is incomplete.',
      )
    const page = await notion(env, `/data_sources/${env.NOTION_DATA_SOURCE_ID}/query`, {
      page_size: 10,
      ...(state.cursor ? { start_cursor: state.cursor } : {}),
      filter: {
        timestamp: 'last_edited_time',
        last_edited_time: { on_or_after: state.watermark },
      },
      sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
    })
    for (const p of page.results) {
      const old = await env.DB.prepare('SELECT edited_at FROM recordings WHERE id=?')
        .bind(p.id)
        .first()
      if (old?.edited_at === p.last_edited_time) continue
      const props = p.properties,
        start = props.recorded_at_ms?.number ?? Date.parse(props['Recorded at']?.date?.start),
        end =
          props.record_finished_at_ms?.number ?? start + (props['Duration (s)']?.number ?? 0) * 1000
      // Unknown wall clocks cannot participate reliably in time ranges.
      const file = props.Transcript?.files?.[0]
      let text = plain(props['Transcript preview']?.rich_text)
      if (file?.file?.url) {
        const url = new URL(file.file.url)
        if (url.protocol !== 'https:') throw Error('Invalid transcript attachment URL.')
        const data = await boundedJson(
          await fetch(url, {
            signal: AbortSignal.timeout(20000),
            redirect: 'manual',
          }),
        )
        if (data.schema !== 'uomi.transcript.v1' || typeof data.text !== 'string')
          throw Error('Invalid Uomi transcript schema.')
        text = data.text
      }
      await env.DB.batch([
        env.DB.prepare(
          'INSERT INTO recordings(id,recorded_at,finished_at,edited_at,device,status,url,text) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET recorded_at=excluded.recorded_at,finished_at=excluded.finished_at,edited_at=excluded.edited_at,device=excluded.device,status=excluded.status,url=excluded.url,text=excluded.text',
        ).bind(
          p.id,
          Number.isFinite(start) ? start : null,
          Number.isFinite(end) ? end : null,
          p.last_edited_time,
          plain(props.Device?.rich_text),
          props.Status?.select?.name ?? 'Pending',
          p.url ?? '',
          text,
        ),
        env.DB.prepare('DELETE FROM transcripts WHERE id=?').bind(p.id),
        env.DB.prepare('INSERT INTO transcripts(id,text) VALUES(?,?)').bind(p.id, text),
      ])
    }
    // Only checkpoint a whole successful page. Retried upserts are safe.
    await env.DB.prepare(
      'UPDATE sync_state SET scanned=?,cursor=?,cycle_start=?,watermark=? WHERE id=1',
    )
      .bind(
        page.has_more ? state.scanned + page.results.length : 0,
        page.has_more ? page.next_cursor : null,
        page.has_more ? cycle : null,
        page.has_more ? state.watermark : new Date(Date.parse(cycle) - 60000).toISOString(),
      )
      .run()
    return {
      processed: page.results.length,
      has_more: page.has_more,
      coverage:
        'Incremental index; archived/deleted Notion pages require explicit removal/rebuild. Search is not a live source of truth.',
    }
  } finally {
    await env.DB.prepare('UPDATE sync_state SET lease_until=0 WHERE id=1').run()
  }
}
async function call(env, name, a) {
  if (!env.DB) throw Error('D1 binding DB is unavailable.')
  if (name === 'sync_index') return sync(env)
  if (name === 'index_status')
    return {
      configured: !!(env.NOTION_TOKEN && env.NOTION_DATA_SOURCE_ID),
      ...(await env.DB.prepare('SELECT count(*) AS recordings FROM recordings').first()),
      sync: await env.DB.prepare(
        'SELECT watermark,cursor IS NOT NULL AS has_more,cycle_start FROM sync_state WHERE id=1',
      ).first(),
      limitations: [
        'Time filters operate on recording intervals, not individual words.',
        'Notion archived/deleted pages are retained until an explicit rebuild.',
        'Sync is explicit and bounded; repeat sync_index to catch up.',
      ],
    }
  if (name === 'read_transcript') {
    if (typeof a.id !== 'string' || a.id.length > 100) throw Error('Invalid recording ID.')
    const offset = integer(a.offset, 0, 0, 10000000),
      length = integer(a.length, 8000, 1, 16000)
    const row = await env.DB.prepare('SELECT id,text,url FROM recordings WHERE id=?')
      .bind(a.id)
      .first()
    if (!row) throw Error('Recording is not indexed.')
    return {
      id: row.id,
      url: row.url,
      text: row.text.slice(offset, offset + length),
      next_offset: offset + length < row.text.length ? offset + length : null,
      total_length: row.text.length,
    }
  }
  if (name === 'search_transcripts' || name === 'recordings_in_range') {
    if (name === 'recordings_in_range' && (!a.from || !a.to))
      throw Error('from and to are required.')
    if (name === 'search_transcripts' && a.query === undefined) throw Error('query is required.')
    const plan = searchPlan(a)
    const { results } = await env.DB.prepare(plan.sql)
      .bind(...plan.args)
      .all()
    const more = results.length > plan.limit,
      rows = results.slice(0, plan.limit),
      last = rows.at(-1)
    return {
      results: rows,
      next_cursor:
        more && last ? btoa(JSON.stringify({ time: last.recorded_at, id: last.id })) : null,
    }
  }
  throw Error('Unknown tool.')
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname
    if (path === '/health') return json({ ok: true })
    if (!request.headers.get('oai-authenticated-user-id'))
      return json({ error: 'Authentication required' }, 401)
    if (path !== '/mcp')
      return new Response(
        'uomi — Private transcript search MCP. Configure NOTION_TOKEN and NOTION_DATA_SOURCE_ID in Sites, then run sync_index until caught up. POST /mcp exposes search_transcripts, recordings_in_range, read_transcript and index_status.',
        { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
      )
    if (request.method !== 'POST') return json({ error: 'POST required' }, 405)
    let rpc
    try {
      if (Number(request.headers.get('content-length')) > 16384) throw Error()
      const body = await request.text()
      if (body.length > 16384) throw Error()
      rpc = JSON.parse(body)
    } catch {
      return json(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Invalid JSON request' },
        },
        400,
      )
    }
    if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string')
      return json(
        {
          jsonrpc: '2.0',
          id: rpc.id ?? null,
          error: { code: -32600, message: 'Invalid Request' },
        },
        400,
      )
    const reply = (result) => json({ jsonrpc: '2.0', id: rpc.id ?? null, result })
    if (rpc.method === 'server/discover')
      return reply({
        supportedVersions: [VERSION],
        capabilities: { tools: {} },
      })
    if (rpc.method === 'initialize')
      return reply({
        protocolVersion: VERSION,
        serverInfo: { name: 'uomi', version: '1.0.0' },
        capabilities: { tools: {} },
      })
    if (rpc.method.startsWith('notifications/')) return new Response(null, { status: 204 })
    if (rpc.method === 'tools/list') return reply({ tools })
    if (rpc.method !== 'tools/call')
      return json({
        jsonrpc: '2.0',
        id: rpc.id ?? null,
        error: { code: -32601, message: 'Method not found' },
      })
    try {
      const result = await call(env, rpc.params?.name, rpc.params?.arguments ?? {})
      return reply({
        content: [{ type: 'text', text: JSON.stringify(result) }],
      })
    } catch (error) {
      const message = String(error.message)
      return reply({
        isError: true,
        content: [
          {
            type: 'text',
            text: /^(D1_|SQLITE_|fetch failed)/.test(message)
              ? 'Index operation failed. Check runtime logs.'
              : message,
          },
        ],
      })
    }
  },
}
