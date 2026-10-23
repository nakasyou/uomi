import { searchCondition } from './search.js'
import { optimizeCache } from './maintenance.ts'
import { loadManifest, saveManifest } from './manifest.ts'
import { Buffer } from 'buffer'
import { oggOpus, oggFrames, stripSyntheticGaps, opusDuration } from '@uomi/audio'
import { NotionStore, httpTransport, type AudioManifest } from '@uomi/notion'
import mcp from './index.js'
import { ranges } from './source-ranges.ts'
export { ranges } from './source-ranges.ts'
import { resync, cachePage } from './notion-cache.ts'

export const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
export const digest = async (value: BufferSource | Uint8Array) =>
  Buffer.from(
    await crypto.subtle.digest(
      'SHA-256',
      new Uint8Array(
        value instanceof ArrayBuffer
          ? value
          : value instanceof Uint8Array
            ? value
            : new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
      ),
    ),
  ).toString('hex')
const MAX_BODY = 12 * 1024 * 1024
async function bytes(request: Request, max = MAX_BODY) {
  const reader = request.body?.getReader()
  if (!reader) throw Error('Request body required')
  const parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const p = await reader.read()
      if (p.done) break
      size += p.value.length
      if (size > max) throw Error('Chunk exceeds 12 MiB. Use shorter chunks.')
      parts.push(p.value)
    }
  } finally {
    await reader.cancel()
  }
  return Buffer.concat(parts)
}
async function body(request: Request, max = MAX_BODY) {
  return JSON.parse((await bytes(request, max)).toString())
}
export async function validateChunk(v: any) {
  if (
    v?.schema !== 'uomi.audio.v1' ||
    v.codec !== 'opus' ||
    v.sampleRate !== 16000 ||
    v.channels !== 1 ||
    typeof v.deviceId !== 'string' ||
    v.deviceId.length > 200 ||
    !Array.isArray(v.frames) ||
    !v.frames.length ||
    v.frames.length > 45000
  )
    throw Error('Invalid Uomi chunk')
  let total = 0
  const ids = new Set()
  for (const f of v.frames) {
    if (
      typeof f.id !== 'string' ||
      ids.has(f.id) ||
      typeof f.data !== 'string' ||
      f.data.length > 4096 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)
    )
      throw Error('Invalid source packet')
    ids.add(f.id)
    const ms = opusDuration(Buffer.from(f.data, 'base64'))
    if (ms !== f.durationMs) throw Error('Opus duration mismatch')
    if (
      !Number.isFinite(f.recordTimestamp) ||
      !/^\d{1,24}$/.test(f.sequence ?? '') ||
      !['device-utc', 'device-uptime'].includes(f.timing) ||
      (f.ringId !== null && (typeof f.ringId !== 'string' || f.ringId.length > 128))
    )
      throw Error('Invalid source timing metadata')
    if (!Number.isFinite(f.offsetMs) || f.offsetMs < 0) throw Error('Invalid source offset')
    if (
      f.capturedAt !== null &&
      (typeof f.capturedAt !== 'string' || !Number.isFinite(Date.parse(f.capturedAt)))
    )
      throw Error('Invalid source clock')
    total += ms
  }
  if (total > 900000 || total !== v.durationMs) throw Error('Chunk duration mismatch')
  return ranges(v.frames)
}
// Dispatch supplies these headers only after private Site authentication.
// Some hosted browser renderers provide email without the stable user ID.
function visitor(request: Request) {
  return request.headers.get('oai-authenticated-user-id') || request.headers.get('oai-authenticated-user-email')
}
async function authorize(request: Request, env: any) {
  if (visitor(request)) return 'owner'
  const secret = request.headers.get('X-Uomi-Secret')
  if (!secret || secret.length < 24) return null
  const hash = await digest(new TextEncoder().encode(secret))
  const row = await env.DB.prepare('SELECT name FROM client_keys WHERE hash=? AND revoked=0')
    .bind(hash)
    .first()
  return row ? 'client' : null
}
async function ingest(request: Request, env: any, ctx: any) {
  const value = await body(request)
  const spans = await validateChunk(value)
  const id = await digest(
    new TextEncoder().encode(JSON.stringify(value.frames.map((f: any) => f.id))),
  )
  if (value.segmentId !== id || request.headers.get('Idempotency-Key') !== id)
    throw Error('Chunk identity mismatch')
  const audio = oggOpus(value.frames),
    sha = await digest(audio)
  const old = await env.DB.prepare('SELECT audio_sha,backup_step FROM recordings WHERE id=?')
    .bind(id)
    .first()
  if (old) {
    if (old.audio_sha !== sha) return json({ error: 'Chunk ID has different audio' }, 409)
    ctx.waitUntil(backup(env, id))
    return json(
      { id, sha256: sha, saved: true, notion_saved: old.backup_step === 'done', duplicate: true },
      old.backup_step === 'done' ? 200 : 202,
    )
  }
  const overlaps = await env.DB.prepare(
    `SELECT DISTINCT r.id AS recording_id FROM source_ranges s JOIN recordings r ON r.rid=s.recording_id JOIN json_each(?) j ON s.prefix=json_extract(j.value,'$.prefix') AND s.start<json_extract(j.value,'$.end') AND s.end>json_extract(j.value,'$.start') WHERE s.device=? LIMIT 9`,
  )
    .bind(JSON.stringify(spans), value.deviceId)
    .all()
  if (overlaps.results.length) {
    if (overlaps.results.length > 8)
      return json({ error: 'Chunk overlaps too many saved recordings; use shorter chunks.' }, 409)
    const expected = new Map(value.frames.map((f: any) => [f.id, f]))
    for (const item of overlaps.results) {
      const saved = await env.DB.prepare(
        'SELECT audio_key,manifest_gzip,manifest_key,backup_step FROM recordings WHERE id=?',
      )
        .bind(item.recording_id)
        .first()
      if (!saved || saved.backup_step !== 'done')
        return json({ error: 'Overlapping source save is still pending; retry later.' }, 409)
      const manifest = await loadManifest(env, saved),
        object = await env.BUCKET.get(saved.audio_key)
      if (!object)
        return json({ error: 'Resync the overlapping recording from Notion before retrying.' }, 409)
      const packets = oggFrames(
        stripSyntheticGaps(
          new Uint8Array(await object.arrayBuffer()),
          manifest.gaps ?? [],
          manifest.frameIds.length,
        ),
      )
      if (packets.length !== manifest.frameIds.length)
        throw Error('Cached source packet count mismatch')
      manifest.frameIds.forEach((frameId, i) => {
        const wanted: any = expected.get(frameId)
        if (wanted) {
          if (wanted.data !== packets[i].data || wanted.durationMs !== packets[i].durationMs)
            throw Error('Source frame identity has different audio')
          expected.delete(frameId)
        }
      })
    }
    if (expected.size === 0)
      return json({ id, sha256: sha, saved: true, notion_saved: true, duplicate: true })
    return json(
      {
        error:
          'Chunk partially overlaps saved audio. Keep local audio and use the original chunk boundaries.',
      },
      409,
    )
  }
  const capturedAt = value.frames[0].capturedAt
  const manifest: AudioManifest = {
    schema: 'uomi.notion.v1',
    id,
    deviceId: value.deviceId,
    capturedAt,
    durationMs: value.durationMs,
    sha256: sha,
    frameIds: value.frames.map((f: any) => f.id),
    timing: [],
  }
  value.frames.forEach((f: any, i: number) => {
    const last = manifest.timing.at(-1)
    if (
      last &&
      last.sequence === f.sequence &&
      last.ringId === f.ringId &&
      last.timestamp === f.recordTimestamp
    )
      last.frames++
    else
      manifest.timing.push({
        sequence: String(f.sequence),
        ringId: f.ringId ?? null,
        timestamp: f.recordTimestamp,
        capturedAt: f.capturedAt,
        firstFrame: i,
        frames: 1,
      })
  })
  const manifestKey = await saveManifest(env, manifest)
  const key = `audio/${sha}.ogg`
  await env.BUCKET.put(key, audio, {
    httpMetadata: { contentType: 'audio/ogg' },
    customMetadata: { sha256: sha },
  })
  const now = new Date().toISOString(),
    start = capturedAt ? Date.parse(capturedAt) : null
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO recordings(id,recorded_at,finished_at,edited_at,device,status,url,text,audio_key,audio_sha,duration_ms,manifest_key,backup_step) VALUES(?,?,?,?,?,'Pending','','',?,?,?,?,'page')",
      ).bind(
        id,
        start,
        start === null ? null : start + value.durationMs,
        now,
        value.deviceId,
        key,
        sha,
        value.durationMs,
        manifestKey,
      ),
      ...spans.map((s) =>
        env.DB.prepare('INSERT INTO source_ranges VALUES(?,?,?,?,(SELECT rid FROM recordings WHERE id=?))').bind(
          value.deviceId,
          s.prefix,
          s.start,
          s.end,
          id,
        ),
      ),
    ])
  } catch (e) {
    if (String(e).includes('Source audio overlaps'))
      return json(
        { error: 'Source frames already belong to another chunk. Local audio retained.' },
        409,
      )
    const winner = await env.DB.prepare('SELECT audio_sha FROM recordings WHERE id=?')
      .bind(id)
      .first()
    if (winner?.audio_sha !== sha) throw e
  }
  ctx.waitUntil(backup(env, id))
  return json({ id, sha256: sha, saved: true, notion_saved: false }, 202)
}

// Durable checkpoints are authoritative. waitUntil is only an opportunistic runner.
export async function backup(env: any, id: string) {
  const token = crypto.randomUUID(),
    now = Date.now()
  let row = await env.DB.prepare('SELECT * FROM recordings WHERE id=? AND audio_key IS NOT NULL')
    .bind(id)
    .first()
  if (!row || row.backup_step === 'done' || row.backup_step === 'uncertain') return
  const lock = await env.DB.prepare(
    'UPDATE recordings SET backup_lease=?,backup_until=? WHERE id=? AND backup_until<?',
  )
    .bind(token, now + 35000, id, now)
    .run()
  if (!lock.meta.changes) return
  const revision = row.revision,
    deadline = now + 24000
  const checkpoint = async (step: string, extra: Record<string, unknown> = {}) => {
    const entries = Object.entries(extra)
    await env.DB.prepare(
      `UPDATE recordings SET backup_step=?,backup_error=NULL${entries.map(([k]) => `,${k}=?`).join('')} WHERE id=? AND backup_lease=? AND revision=?`,
    )
      .bind(step, ...entries.map(([, v]) => v), id, token, revision)
      .run()
    Object.assign(row, extra, { backup_step: step })
  }
  try {
    if (!env.NOTION_TOKEN || !env.NOTION_DATA_SOURCE_ID)
      throw Error('Configure Notion backup credentials')
    const transport = httpTransport(env.NOTION_TOKEN, ((url: any, init: any) =>
      fetch(url, {
        ...init,
        signal: AbortSignal.timeout(Math.max(1000, Math.min(7000, deadline - Date.now()))),
      })) as typeof fetch)
    const store = new NotionStore(transport, env.NOTION_DATA_SOURCE_ID)
    const manifest = await loadManifest(env, row)
    while (Date.now() < deadline - 2500) {
      if (row.backup_step === 'page') {
        await store.setup()
        const existing = await store.find(id)
        if (existing) {
          await checkpoint('audio', { backup_page: existing.id })
          continue
        }
        await checkpoint('uncertain')
        const page = await store.reserve(manifest)
        await checkpoint('audio', { backup_page: page.id })
      } else if (row.backup_step === 'audio') {
        const file = await env.BUCKET.get(row.audio_key)
        if (!file) throw Error('Saved audio is unavailable')
        const uploaded = await store.upload(
          `${id}.ogg`,
          'audio/ogg',
          new Uint8Array(await file.arrayBuffer()),
        )
        await checkpoint('manifest', { backup_audio: uploaded })
      } else if (row.backup_step === 'manifest') {
        const uploaded = await store.upload(
          `${id}.json`,
          'application/json',
          Buffer.from(JSON.stringify(manifest)),
        )
        await checkpoint('attach', { backup_manifest: uploaded })
      } else if (row.backup_step === 'attach') {
        if (!(await store.reusableUpload(row.backup_audio))) {
          await checkpoint('audio', { backup_audio: null })
          continue
        }
        if (!(await store.reusableUpload(row.backup_manifest))) {
          await checkpoint('manifest', { backup_manifest: null })
          continue
        }
        const page = await store.page(row.backup_page)
        await store.attachAudio(manifest, page, row.backup_audio, row.backup_manifest)
        await checkpoint('verify', { url: page.url ?? '' })
      } else if (row.backup_step === 'verify') {
        const page = await store.page(row.backup_page)
        const response = await fetch(store.fileUrl(page, 'Audio'), {
          redirect: 'manual',
          signal: AbortSignal.timeout(Math.max(1000, Math.min(7000, deadline - Date.now()))),
        })
        if (!response.ok) throw Error('Notion audio verification failed')
        const saved = await response.arrayBuffer()
        if (saved.byteLength > 20 * 1024 * 1024 || (await digest(saved)) !== row.audio_sha)
          throw Error('Notion saved audio hash mismatch')
        await checkpoint('transcript')
      } else if (row.backup_step === 'transcript') {
        if (row.status === 'Completed')
          await store.saveTranscript(row.backup_page, row.text, 'uomi-web')
        await checkpoint('done', { backup_revision: revision })
        break
      } else break
    }
  } catch (e) {
    await env.DB.prepare('UPDATE recordings SET backup_error=? WHERE id=? AND backup_lease=?')
      .bind(String((e as Error).message).slice(0, 1000), id, token)
      .run()
  } finally {
    await env.DB.prepare(
      'UPDATE recordings SET backup_lease=NULL,backup_until=0 WHERE id=? AND backup_lease=?',
    )
      .bind(id, token)
      .run()
  }
}

async function requireSearchReady(env: any) {
  const state = await optimizeCache(env)
  if (state.search_remaining) throw Error('Search index upgrade in progress; retry to continue the bounded migration')
}

async function api(request: Request, env: any, ctx: any, role: string) {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method
  if (path === '/api/resync' && method === 'POST') {
    const data = await body(request, 4096)
    return json(await resync(env, data.reset === true))
  }
  if (path === '/api/chunks' && method === 'POST') return ingest(request, env, ctx)
  if (path === '/api/recordings' && method === 'GET') {
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 30)),
      clauses: string[] = [],
      args: any[] = []
    let join = ''
    const query = url.searchParams.get('q')
    if (query) {
      await requireSearchReady(env)
      const condition = searchCondition(query)
      join = condition.join
      clauses.push(condition.sql)
      args.push(...condition.values)
    }
    for (const [param, op, col] of [
      ['from', '>', 'finished_at'],
      ['to', '<', 'recorded_at'],
    ]) {
      const value = url.searchParams.get(param)
      if (value) {
        const time = Date.parse(value)
        if (!Number.isFinite(time)) throw Error('Invalid date range')
        clauses.push(`r.${col}${op}?`)
        args.push(time)
      }
    }
    if (url.searchParams.get('starred') === '1') clauses.push('r.starred=1')
    const cursor = url.searchParams.get('cursor')
    if (cursor) {
      const c = JSON.parse(atob(cursor))
      if (!Number.isFinite(c.time) || typeof c.id !== 'string') throw Error('Invalid cursor')
      clauses.push('(COALESCE(r.recorded_at,0)<? OR (COALESCE(r.recorded_at,0)=? AND r.id<?))')
      args.push(c.time, c.time, c.id)
    }
    const { results } = await env.DB.prepare(
      `SELECT r.id,r.title,r.recorded_at,r.finished_at,r.duration_ms,r.status,r.starred,r.backup_step,r.backup_error,r.audio_key IS NOT NULL AS has_audio,substr(r.text,1,240) AS preview FROM recordings r${join}${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ORDER BY COALESCE(r.recorded_at,0) DESC,r.id DESC LIMIT ?`,
    )
      .bind(...args, limit + 1)
      .all()
    const last = results[limit - 1]
    return json({
      results: results.slice(0, limit),
      next_cursor:
        results.length > limit
          ? btoa(JSON.stringify({ time: last.recorded_at ?? 0, id: last.id }))
          : null,
    })
  }
  const match = path.match(
    /^\/api\/recordings\/([a-zA-Z0-9-]+)(?:\/(audio|backup|transcript|resync))?$/,
  )
  if (match) {
    const [, id, action] = match
    let row = await env.DB.prepare('SELECT * FROM recordings WHERE id=?').bind(id).first()
    if (!row) return json({ error: 'Recording not found' }, 404)
    if (action === 'resync' && method === 'POST') {
      const store = new NotionStore(httpTransport(env.NOTION_TOKEN), env.NOTION_DATA_SOURCE_ID)
      const page = await store.page(row.backup_page ?? id)
      if (!(await store.owns(page)))
        return json({ error: 'Page is outside the configured source' }, 403)
      return json(await cachePage(env, page))
    }
    if (action === 'audio' && method === 'GET') {
      if (!row.audio_key)
        return json({ error: 'Legacy recording; audio has not been imported from Notion' }, 404)
      const range = request.headers.get('Range')
      const object = await env.BUCKET.get(row.audio_key, {
        ...(range ? { range: request.headers } : {}),
      })
      if (!object) return json({ error: 'Audio missing' }, 404)
      const headers = new Headers({
        'Content-Type': 'audio/ogg',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-store',
        ETag: object.httpEtag,
      })
      let status = 200
      if (object.range) {
        const offset = object.range.offset ?? 0,
          length = object.range.length ?? object.size
        headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`)
        headers.set('Content-Length', String(length))
        status = 206
      } else headers.set('Content-Length', String(object.size))
      return new Response(object.body, { status, headers })
    }
    if (action === 'backup' && method === 'POST') {
      if (row.backup_step === 'uncertain') {
        const store = new NotionStore(httpTransport(env.NOTION_TOKEN), env.NOTION_DATA_SOURCE_ID)
        const page = await store.find(id)
        if (!page)
          return json(
            {
              error:
                'Page creation outcome is uncertain. Check Notion before allowing another creation.',
            },
            409,
          )
        await env.DB.prepare(
          "UPDATE recordings SET backup_page=?,backup_step='audio' WHERE id=? AND backup_step='uncertain'",
        )
          .bind(page.id, id)
          .run()
      }
      ctx.waitUntil(backup(env, id))
      return json({ accepted: true }, 202)
    }
    if (!action && method === 'PATCH') {
      const data = await body(request, 4096)
      if (data.title !== undefined && (typeof data.title !== 'string' || data.title.length > 200))
        throw Error('Invalid title')
      if (data.starred !== undefined && typeof data.starred !== 'boolean')
        throw Error('Invalid starred flag')
      if (!row.backup_page && row.backup_step !== 'legacy')
        throw Error('Wait for the Notion save before editing')
      const store = new NotionStore(httpTransport(env.NOTION_TOKEN), env.NOTION_DATA_SOURCE_ID)
      await store.setup()
      const props: any = {}
      if (data.title !== undefined)
        props.Name = { title: [{ type: 'text', text: { content: data.title } }] }
      if (data.starred !== undefined) props.Starred = { checkbox: data.starred }
      await store.update(row.backup_page ?? id, props)
      await env.DB.prepare('UPDATE recordings SET title=?,starred=? WHERE id=?')
        .bind(
          data.title ?? row.title,
          data.starred === undefined ? row.starred : Number(data.starred),
          id,
        )
        .run()
      return json({ saved: true })
    }
    if (!action && method === 'GET')
      return json({
        id: row.id,
        title: row.title,
        recorded_at: row.recorded_at,
        duration_ms: row.duration_ms ?? row.finished_at - row.recorded_at,
        status: row.status,
        text: row.text,
        starred: !!row.starred,
        has_audio: !!row.audio_key,
        backup_step: row.backup_step,
        backup_error: row.backup_error,
        url: row.url,
      })
  }
  if (path === '/api/jobs' && method === 'GET') {
    const { results } = await env.DB.prepare(
      "SELECT id,status FROM recordings WHERE audio_key IS NOT NULL AND status IN ('Pending','Failed') ORDER BY recorded_at LIMIT 10",
    ).all()
    return json({ results })
  }
  if (path === '/api/clients' && role === 'owner') {
    if (method === 'GET')
      return json(
        await env.DB.prepare(
          'SELECT hash,name,created_at,revoked FROM client_keys ORDER BY created_at DESC',
        ).all(),
      )
    if (method === 'POST') {
      const data = await body(request, 4096)
      if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 100)
        throw Error('Device name required')
      const secret = crypto.randomUUID() + crypto.randomUUID()
      const hash = await digest(new TextEncoder().encode(secret))
      await env.DB.prepare('INSERT INTO client_keys(hash,name,created_at) VALUES(?,?,?)')
        .bind(hash, data.name.trim(), Date.now())
        .run()
      return json(
        {
          secret,
          access_token: env.SITES_ACCESS_TOKEN ?? null,
          upload_url: url.origin + '/api/chunks',
        },
        201,
      )
    }
  }
  if (path.startsWith('/api/clients/') && method === 'DELETE' && role === 'owner') {
    await env.DB.prepare('UPDATE client_keys SET revoked=1 WHERE hash=?')
      .bind(path.split('/').at(-1))
      .run()
    return json({ revoked: true })
  }
  return json({ error: 'Not found' }, 404)
}
export default {
  async fetch(request: Request, env: any, ctx: any): Promise<Response> {
    try {
      const path = new URL(request.url).pathname
      if (path === '/health') return json({ ok: true })
      if (path === '/mcp') {
        if (request.method === 'POST' && visitor(request)) {
          const rpc: any = await request.clone().json()
          if (rpc.method === 'tools/call' && rpc.params?.name === 'search_transcripts') await requireSearchReady(env)
          if (rpc.method === 'tools/call' && rpc.params?.name === 'index_status') {
            const count = await env.DB.prepare(
              "SELECT count(*) AS recordings,sum(audio_key IS NOT NULL) AS cached_audio,sum(backup_step NOT IN ('done','legacy')) AS pending_notion_saves FROM recordings",
            ).first()
            const optimization = await optimizeCache(env)
            const storage = await env.DB.prepare(
              `SELECT coalesce(sum(length(CAST(text AS BLOB))),0) AS transcript_utf8_bytes,
              coalesce(sum(length(text)),0) AS transcript_characters,
              coalesce(sum(length(CAST(search_text AS BLOB))),0) AS normalized_utf8_bytes,
              coalesce(sum(length(manifest_gzip)),0) AS manifest_gzip_bytes,
              sum(manifest_key IS NOT NULL) AS r2_manifests FROM recordings`,
            ).all()
            const fts = await env.DB.prepare(
              `SELECT 0 AS fts_content_bytes,
              (SELECT coalesce(sum(length(block)),0) FROM transcripts_data) AS fts_data_bytes,
              (SELECT coalesce(sum(length(term)),0) FROM transcripts_idx) AS fts_term_bytes,
              0 AS fts_docsize_bytes`,
            ).first()
            const daily = await env.DB.prepare(
              `SELECT date(recorded_at/1000,'unixepoch','+9 hours') AS day_jst,
              count(*) AS recordings, sum(length(CAST(text AS BLOB))) AS transcript_utf8_bytes,
              sum(length(text)) AS transcript_characters,
              sum(max(0,coalesce(finished_at,recorded_at)-recorded_at)) AS recorded_ms
              FROM recordings WHERE recorded_at IS NOT NULL GROUP BY day_jst ORDER BY day_jst`,
            ).all()
            const state = await env.DB.prepare(
              'SELECT since,cursor IS NOT NULL AS has_more,started FROM resync_state WHERE id=1',
            ).first()
            return json({
              jsonrpc: '2.0',
              id: rpc.id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      configured: !!(env.NOTION_TOKEN && env.NOTION_DATA_SOURCE_ID),
                      source: 'Notion',
                      ...count,
                      sync: state,
                      optimization,
                      storage: {
                        database_bytes: storage.meta?.size_after ?? null,
                        ...storage.results[0],
                        ...fts,
                        note: 'Database bytes are physical D1 size. Component bytes are payload only, excluding SQLite page/B-tree overhead; FTS data may include pending merge segments.',
                        daily: daily.results,
                      },
                      limitations: [
                        'Recording-level time ranges; no word timestamps.',
                        'Run sync_index or Web Recorder source resync to refresh persistent caches.',
                      ],
                    }),
                  },
                ],
              },
            })
          }
          if (rpc.method === 'tools/call' && rpc.params?.name === 'sync_index') {
            try {
              return json({
                jsonrpc: '2.0',
                id: rpc.id,
                result: { content: [{ type: 'text', text: JSON.stringify(await resync(env)) }] },
              })
            } catch (e) {
              return json({
                jsonrpc: '2.0',
                id: rpc.id,
                result: { isError: true, content: [{ type: 'text', text: (e as Error).message }] },
              })
            }
          }
        }
        return mcp.fetch(request, env)
      }
      if (!path.startsWith('/api/'))
        return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 })
      const role = await authorize(request, env)
      if (!role) return json({ error: 'Authentication required' }, 401)
      if (request.method !== 'GET' && visitor(request)) {
        const origin = request.headers.get('Origin')
        if (origin && origin !== new URL(request.url).origin)
          return json({ error: 'Cross-origin write rejected' }, 403)
      }
      return await api(request, env, ctx, role)
    } catch (e) {
      return json({ error: String((e as Error).message).slice(0, 1000) }, 400)
    }
  },
}
