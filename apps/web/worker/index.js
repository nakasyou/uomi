import { resync } from './notion-cache.ts'
import { searchCondition } from './search.js'
const VERSION = '2026-07-28'
const json = (data, status = 200) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } })
const object = (properties) => ({
  type: 'object',
  properties,
  additionalProperties: false,
})
const tools = [
  {
    name: 'search_transcripts',
    description:
      'Search Uomi recordings. Normalized substring: NFKC, lowercase, kana and whitespace folding. Two characters use a literal LIKE scan; longer queries use compact trigram candidates with exact verification. Optional recording overlap range uses ISO-8601 timestamps with timezone. Results are recording-level, not word-level. New transcripts are searchable immediately; sync_index imports earlier Notion recordings.',
    inputSchema: object({
      query: { type: 'string', minLength: 2, maxLength: 200 },
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
      'Import earlier recordings from Notion, one recording per call. Repeat until has_more=false. Existing primary recordings are preserved.',
    inputSchema: object({}),
  },
].map((t) => ({
  ...t,
  annotations: {
    readOnlyHint: !['sync_index', 'index_status'].includes(t.name),
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
    clauses.push('r.recorded_at < ? AND r.sort_time < ?')
    args.push(time(a.to), time(a.to))
  }
  if (a.from !== undefined && a.to !== undefined && time(a.from) >= time(a.to))
    throw Error('from must precede to.')
  let join = ''
  if (a.query !== undefined) {
    const condition = searchCondition(a.query)
    join = condition.join
    clauses.push(condition.sql)
    args.push(...condition.values)
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
    clauses.push('(r.sort_time,r.id) > (?,?)')
    args.push(c.time ?? 0, c.id)
  }
  return {
    sql: `SELECT r.id,r.recorded_at,r.finished_at,r.device,r.status,r.url,substr(r.text,1,1200) AS preview FROM recordings r${join} ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY r.sort_time,r.id LIMIT ?`,
    args: [...args, limit + 1],
    limit,
  }
}
async function call(env, name, a) {
  if (!env.DB) throw Error('D1 binding DB is unavailable.')
  if (name === 'sync_index') return resync(env)
  if (name === 'index_status')
    return {
      configured: !!(env.DB && env.BUCKET),
      backup_configured: !!(env.NOTION_TOKEN && env.NOTION_DATA_SOURCE_ID),
      ...(await env.DB.prepare('SELECT count(*) AS recordings FROM recordings').first()),
      limitations: [
        'Time filters operate on recording intervals, not individual words.',
        'Notion import preserves primary server recordings.',
        'Notion migration is explicit and bounded; repeat sync_index to finish.',
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
    if (
      a.from !== undefined &&
      !(await env.DB.prepare('SELECT 1 FROM recordings WHERE finished_at>? LIMIT 1')
        .bind(time(a.from))
        .first())
    )
      return { results: [], next_cursor: null }
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
        'Uomi transcript API. POST /mcp exposes search_transcripts, recordings_in_range, read_transcript and index_status. Notion backup is optional.',
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
