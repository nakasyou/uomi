import { backupState } from './backup-state.ts'
import { storageDiagnostics } from './storage-diagnostics.ts'
import { refreshTranscript, webhookAuthorized } from './transcriber.ts'
import { searchCondition } from './search.js'
import { optimizeCache } from './maintenance.ts'
import { loadManifest, saveManifest } from './manifest.ts'
import { Buffer } from 'buffer'
import {
  oggOpus,
  oggFrames,
  stripSyntheticGaps,
  OGG_UPLOAD_TYPE,
  decodeOggUpload,
} from '@uomi/audio'
import { NotionStore, httpTransport, validateManifest, type AudioManifest } from '@uomi/notion'
import mcp from './index.js'
import { ranges, overlappingRecordingsSql } from './source-ranges.ts'
export { ranges } from './source-ranges.ts'
import { enqueue, enqueueLongDefault, jobsApi, jobView, ApiError } from './jobs.ts'
import { detailedTranscription } from './detailed-transcription.ts'
import { transcriptionStatus } from './transcription-control.ts'
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
  if (!reader) throw new ApiError('Request body required')
  const parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const p = await reader.read()
      if (p.done) break
      size += p.value.length
      if (size > max) throw new ApiError('Chunk exceeds 12 MiB. Use shorter chunks.')
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
    !v.frames.length
  )
    throw new ApiError('Invalid Uomi chunk')
  const ids = new Set()
  for (const f of v.frames) {
    if (
      typeof f.id !== 'string' ||
      ids.has(f.id) ||
      typeof f.data !== 'string' ||
      f.data.length > 4096 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)
    )
      throw new ApiError('Invalid source packet')
    ids.add(f.id)
    if (
      !Number.isFinite(f.recordTimestamp) ||
      !/^\d{1,24}$/.test(f.sequence ?? '') ||
      !['device-utc', 'device-uptime'].includes(f.timing) ||
      (f.ringId !== null && (typeof f.ringId !== 'string' || f.ringId.length > 128))
    )
      throw new ApiError('Invalid source timing metadata')
    if (!Number.isFinite(f.offsetMs) || f.offsetMs < 0) throw new ApiError('Invalid source offset')
    if (
      f.capturedAt !== null &&
      (typeof f.capturedAt !== 'string' || !Number.isFinite(Date.parse(f.capturedAt)))
    )
      throw new ApiError('Invalid source clock')
  }
  return ranges(v.frames)
}
// Dispatch supplies these headers only after private Site authentication.
// Some hosted browser renderers provide email without the stable user ID.
function visitor(request: Request) {
  return (
    request.headers.get('oai-authenticated-user-id') ||
    request.headers.get('oai-authenticated-user-email')
  )
}
async function authorize(request: Request, env: any) {
  if (visitor(request)) return 'owner'
  const secret = request.headers.get('X-Uomi-Worker-Secret') ?? request.headers.get('X-Uomi-Secret')
  if (!secret || secret.length < 24) return null
  const hash = await digest(new TextEncoder().encode(secret))
  const workerSecret = env.UOMI_WORKER_SECRET || env.UOMI_WEBHOOK_SECRET
  if (typeof workerSecret === 'string' && workerSecret.length >= 24) {
    const expected = await digest(new TextEncoder().encode(workerSecret))
    let difference = 0
    for (let i = 0; i < hash.length; i++) difference |= hash.charCodeAt(i) ^ expected.charCodeAt(i)
    if (difference === 0) return 'worker'
  }
  const row = await env.DB.prepare('SELECT name FROM client_keys WHERE hash=? AND revoked=0')
    .bind(hash)
    .first()
  return row ? 'client' : null
}
function legacyManifest(value: any, id: string, sha: string): AudioManifest {
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
  return manifest
}
async function ingest(request: Request, env: any, ctx: any) {
  const binary = request.headers.get('Content-Type')?.split(';')[0] === OGG_UPLOAD_TYPE
  let audio: Buffer
  let manifest: AudioManifest
  if (binary) {
    const upload = decodeOggUpload(await bytes(request))
    try {
      validateManifest(upload.manifest)
    } catch (e) {
      throw new ApiError((e as Error).message)
    }
    manifest = upload.manifest
    audio = upload.audio
  } else {
    // Keep older installed clients working during the binary protocol rollout.
    const value = await body(request)
    await validateChunk(value)
    audio = oggOpus(value.frames)
    manifest = legacyManifest(value, value.segmentId, await digest(audio))
  }
  const id = await digest(new TextEncoder().encode(JSON.stringify(manifest.frameIds)))
  if (manifest.id !== id || request.headers.get('Idempotency-Key') !== id)
    throw new ApiError('Chunk identity mismatch')
  if (
    typeof manifest.deviceId !== 'string' ||
    manifest.deviceId.length > 200 ||
    (manifest.capturedAt !== null && !Number.isFinite(Date.parse(manifest.capturedAt)))
  )
    throw new ApiError('Invalid source metadata')
  const sha = await digest(audio)
  if (manifest.sha256 !== sha) throw new ApiError('Ogg audio hash mismatch')
  const spans = ranges(manifest.frameIds.map((id) => ({ id })))
  const old = await env.DB.prepare(
    'SELECT audio_sha,backup_step,backup_error,backup_until,backup_revision,revision,audio_key,id AS recording_id FROM recordings WHERE id=?1 UNION ALL SELECT a.audio_sha,r.backup_step,r.backup_error,r.backup_until,r.backup_revision,r.revision,r.audio_key,r.id AS recording_id FROM chunk_aliases a JOIN recordings r ON r.id=a.recording_id WHERE a.id=?1 LIMIT 1',
  )
    .bind(id)
    .first()
  if (old) {
    if (old.audio_sha !== sha) return json({ error: 'Chunk ID has different audio' }, 409)
    await enqueue(env, old.recording_id)
    await enqueueLongDefault(env, old.recording_id)
    ctx.waitUntil(backup(env, old.recording_id))
    return json(
      {
        id,
        sha256: sha,
        saved: true,
        notion_saved: backupState(env, old).backup_saved,
        ...backupState(env, old),
        backup_step: old.backup_step,
        duplicate: true,
        transcription: jobView(
          await env.DB.prepare(
            "SELECT * FROM transcription_jobs WHERE recording_id=? AND mode='standard'",
          )
            .bind(old.recording_id)
            .first(),
        ),
      },
      200,
    )
  }
  const overlaps = await env.DB.prepare(overlappingRecordingsSql)
    .bind(JSON.stringify(spans), manifest.deviceId)
    .all()
  if (overlaps.results.length) {
    if (overlaps.results.length > 8)
      return json({ error: 'Chunk overlaps too many saved recordings; use shorter chunks.' }, 409)
    // Decode packets only when comparing an upload with existing source claims.
    const uploadedPackets = oggFrames(audio)
    const expected = new Map(manifest.frameIds.map((id, i) => [id, uploadedPackets[i]]))
    let notionSaved = true,
      overlapBackup: ReturnType<typeof backupState> | undefined
    for (const item of overlaps.results) {
      const saved = await env.DB.prepare(
        'SELECT audio_key,manifest_gzip,manifest_key,backup_step,backup_error,backup_until,backup_revision,revision FROM recordings WHERE id=?',
      )
        .bind(item.recording_id)
        .first()
      if (!saved)
        return json({ error: 'Overlapping source save is still pending; retry later.' }, 409)
      const state = backupState(env, saved)
      notionSaved &&= state.backup_saved
      if (!overlapBackup || (overlapBackup.backup_saved && !state.backup_saved))
        overlapBackup = state
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
        throw new ApiError('Cached source packet count mismatch')
      manifest.frameIds.forEach((frameId, i) => {
        const wanted: any = expected.get(frameId)
        if (expected.has(frameId)) {
          if (!wanted) throw new ApiError('Missing source packet in uploaded Ogg')
          if (wanted.data !== packets[i].data || wanted.durationMs !== packets[i].durationMs)
            throw new ApiError('Source frame identity has different audio')
          expected.delete(frameId)
        }
      })
    }
    if (expected.size === 0) {
      const canonicalId = overlaps.results[0].recording_id
      await env.DB.prepare(
        'INSERT OR IGNORE INTO chunk_aliases(id,audio_sha,recording_id) VALUES(?,?,?)',
      )
        .bind(id, sha, canonicalId)
        .run()
      return json({
        id,
        sha256: sha,
        saved: true,
        notion_saved: notionSaved,
        duplicate: true,
        ...overlapBackup,
        backup_saved: notionSaved,
      })
    }
    return json(
      {
        error:
          'Chunk partially overlaps saved audio. Keep local audio and use the original chunk boundaries.',
      },
      409,
    )
  }
  const capturedAt = manifest.capturedAt
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
        "INSERT INTO recordings(id,recorded_at,finished_at,edited_at,device,status,url,text,audio_key,audio_sha,duration_ms,manifest_key,backup_step,primary_owned,long_status) VALUES(?,?,?,?,?,'Pending','','',?,?,?,?,'page',1,'Pending')",
      ).bind(
        id,
        start,
        start === null ? null : start + manifest.durationMs,
        now,
        manifest.deviceId,
        key,
        sha,
        manifest.durationMs,
        manifestKey,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO transcription_jobs(id,recording_id,mode,created_at,updated_at)
         SELECT ?||':'||value,?,value,?,? FROM json_each('["standard","long"]')`,
      ).bind(id, id, Date.now(), Date.now()),
      // One statement keeps all claims atomic without a statement per source packet.
      env.DB.prepare(`INSERT INTO source_ranges
        SELECT ?,json_extract(value,'$.prefix'),json_extract(value,'$.start'),json_extract(value,'$.end'),
          (SELECT rid FROM recordings WHERE id=?) FROM json_each(?)`).bind(
        manifest.deviceId,
        id,
        JSON.stringify(spans),
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
  const transcription = jobView(await enqueue(env, id))
  ctx.waitUntil(backup(env, id))
  return json(
    {
      id,
      sha256: sha,
      saved: true,
      notion_saved: false,
      transcription,
      ...backupState(env, {
        audio_key: key,
        backup_step: 'page',
        backup_revision: -1,
        revision: 0,
      }),
    },
    201,
  )
}

// Durable checkpoints are authoritative. waitUntil is only an opportunistic runner.
export async function backup(env: any, id: string, retryCreation = false) {
  const token = crypto.randomUUID(),
    now = Date.now()
  let row = await env.DB.prepare('SELECT * FROM recordings WHERE id=? AND audio_key IS NOT NULL')
    .bind(id)
    .first()
  if (row?.notion_edited != null && row.revision === 0) return
  if (!row || (row.backup_step === 'done' && row.backup_revision >= row.revision)) return
  if (!env.NOTION_TOKEN || !env.NOTION_DATA_SOURCE_ID || row.backup_next_attempt > now) return
  if (row.backup_step === 'done') row.backup_step = 'transcript'
  if (row.backup_step === 'legacy') row.backup_step = row.backup_page ? 'transcript' : 'page'
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
    const result = await env.DB.prepare(
      `UPDATE recordings SET backup_step=?,backup_error=NULL,backup_attempts=0,backup_next_attempt=0${entries.map(([k]) => `,${k}=?`).join('')} WHERE id=? AND backup_lease=? AND revision=?`,
    )
      .bind(step, ...entries.map(([, v]) => v), id, token, revision)
      .run()
    if (!result.meta.changes)
      throw Error(
        'Backup paused because the recording changed; the latest revision will be backed up on retry',
      )
    Object.assign(row, extra, { backup_step: step })
  }
  let createJournaled = false,
    createMayHaveSucceeded = false
  try {
    if (!env.NOTION_TOKEN || !env.NOTION_DATA_SOURCE_ID)
      throw Error('Configure Notion backup credentials')
    const transport = httpTransport(env.NOTION_TOKEN, (async (url: any, init: any) => {
      const creating = init.method === 'POST' && new URL(url).pathname === '/v1/pages'
      if (creating) createMayHaveSucceeded = true
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(Math.max(1000, Math.min(7000, deadline - Date.now()))),
      })
      // Explicit validation/auth/rate-limit rejections did not create a page.
      // Timeouts and server failures remain ambiguous and must be reconciled.
      if (creating && [400, 401, 403, 404, 422, 429].includes(response.status))
        createMayHaveSucceeded = false
      return response
    }) as typeof fetch)
    const store = new NotionStore(transport, env.NOTION_DATA_SOURCE_ID)
    const manifest = await loadManifest(env, row)
    while (Date.now() < deadline - 2500) {
      if (row.backup_step === 'page' || row.backup_step === 'uncertain') {
        await store.setup()
        const existing = await store.find(manifest.id)
        if (existing) {
          await checkpoint('audio', { backup_page: existing.id })
          continue
        }
        if (row.backup_step === 'uncertain' && !retryCreation)
          throw Error(
            'Notion page creation is unconfirmed; retry backup after checking the backup destination',
          )
        // Leave enough time for the paced create request and durable checkpoint.
        if (Date.now() > deadline - 10000) break
        await checkpoint('uncertain')
        createJournaled = true
        const page = await store.createReservedPage(manifest)
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
        await store.update(row.backup_page, {
          Name: { title: [{ type: 'text', text: { content: row.title || id } }] },
          Starred: { checkbox: !!row.starred },
        })
        if (row.status === 'Completed')
          await store.saveTranscript(
            row.backup_page,
            row.text,
            'uomi-web',
            'standard',
            JSON.parse(row.transcript_segments),
          )
        if (row.long_status === 'Completed') {
          await store.setup()
          await store.saveTranscript(
            row.backup_page,
            row.long_text,
            'chrome-recognizetion',
            'long',
            [],
          )
        }
        if (row.detailed_status === 'Completed')
          await store.saveTranscript(
            row.backup_page,
            row.detailed_text,
            'codex',
            'detailed',
            JSON.parse(row.detailed_segments),
          )
        await checkpoint('done', { backup_revision: revision })

        break
      } else break
    }
  } catch (e) {
    if (createJournaled && !createMayHaveSucceeded && row.backup_step === 'uncertain')
      await checkpoint('page')
    console.error(
      JSON.stringify({
        event: 'notion_backup_failed',
        recording_id: id,
        error: String(e),
        stack: (e as Error).stack,
      }),
    )
    await env.DB.prepare(
      'UPDATE recordings SET backup_error=?,backup_attempts=backup_attempts+1,backup_next_attempt=? WHERE id=? AND backup_lease=?',
    )
      .bind(
        String((e as Error).message).slice(0, 4000),
        Date.now() + Math.min(3600000, 15000 * 2 ** Math.min(row.backup_attempts, 8)),
        id,
        token,
      )
      .run()
  } finally {
    await env.DB.prepare(
      'UPDATE recordings SET backup_lease=NULL,backup_until=0 WHERE id=? AND backup_lease=?',
    )
      .bind(id, token)
      .run()
  }
}

export const pendingBackupsSql =
  "SELECT id FROM recordings WHERE audio_key IS NOT NULL AND (notion_edited IS NULL OR revision>0) AND backup_until<? AND backup_next_attempt<=? AND (backup_step NOT IN ('done','legacy') OR backup_revision<revision) ORDER BY backup_next_attempt,backup_until LIMIT 2"
async function resumeBackups(env: any) {
  if (!env.NOTION_TOKEN || !env.NOTION_DATA_SOURCE_ID) return
  const rows = await env.DB.prepare(pendingBackupsSql).bind(Date.now(), Date.now()).all()
  await Promise.allSettled(rows.results.map((r: any) => backup(env, r.id)))
}
async function requireSearchReady(env: any) {
  const dirty = await env.DB.prepare(
    'SELECT 1 FROM recordings WHERE search_version=0 LIMIT 1',
  ).first()
  if (!dirty) return
  const state = await optimizeCache(env)
  if (state.search_remaining)
    throw Error('Search index upgrade in progress; retry to continue the bounded migration')
}

async function api(request: Request, env: any, ctx: any, role: string) {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method
  if (path === '/api/migrations/notion') {
    if (!['worker', 'owner'].includes(role))
      return json({ error: 'Worker or owner access required' }, 403)
    if (method === 'GET') {
      const state = await env.DB.prepare(
        'SELECT since,cursor,started,lease_until,last_error,updated_at FROM resync_state WHERE id=1',
      ).first()
      return json({
        status: !state
          ? 'not_started'
          : state.lease_until > Date.now()
            ? 'running'
            : state.last_error
              ? 'failed'
              : state.cursor
                ? 'paused'
                : state.since === '1970-01-01T00:00:00.000Z'
                  ? 'not_started'
                  : 'completed',
        lease_until: state?.lease_until ?? 0,
        has_more: !!state?.cursor,
        watermark: state?.since ?? null,
        started: state?.started ?? null,
        error: state?.last_error ?? null,
        updated_at: state?.updated_at ?? null,
      })
    }
    if (method === 'POST') {
      const data = request.body ? await body(request, 4096) : {}
      if (data.reset !== undefined && typeof data.reset !== 'boolean')
        throw new ApiError('reset must be boolean')
      return json(await resync(env, data.reset === true))
    }
  }
  if (path === '/api/resync' && method === 'POST') {
    const data = await body(request, 4096)
    return json(await resync(env, data.reset === true))
  }
  if (path === '/api/transcriptions' && method === 'GET') {
    const params = Object.fromEntries(url.searchParams)
    return json(
      await transcriptionStatus(env, {
        ...params,
        limit: params.limit === undefined ? undefined : Number(params.limit),
      }),
    )
  }
  if (path === '/api/jobs' || path.startsWith('/api/jobs/')) {
    if (path === '/api/jobs/claim') ctx.waitUntil(resumeBackups(env))
    return json(
      await jobsApi(request, env, method === 'POST' ? await body(request, 4 * 1024 * 1024) : {}),
    )
  }
  if (path === '/api/chunks' && method === 'POST') return ingest(request, env, ctx)
  if (path === '/api/chunks/status' && method === 'POST') {
    const { ids } = await body(request, 8192)
    if (
      !Array.isArray(ids) ||
      ids.length > 64 ||
      !ids.length ||
      ids.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
    )
      throw new ApiError('Expected 1–64 chunk IDs')
    const { results } = await env.DB.prepare(
      'SELECT id,id AS recording_id,backup_step,backup_error,backup_until,backup_revision,revision,audio_key FROM recordings WHERE id IN (SELECT value FROM json_each(?1)) UNION ALL SELECT a.id,r.id AS recording_id,r.backup_step,r.backup_error,r.backup_until,r.backup_revision,r.revision,r.audio_key FROM chunk_aliases a JOIN recordings r ON r.id=a.recording_id WHERE a.id IN (SELECT value FROM json_each(?1))',
    )
      .bind(JSON.stringify(ids))
      .all()
    const rows = new Map<string, any>(results.map((r: any) => [r.id, r]))
    const jobs = await env.DB.prepare(
      "SELECT * FROM transcription_jobs WHERE mode='standard' AND recording_id IN (SELECT value FROM json_each(?1) UNION SELECT recording_id FROM chunk_aliases WHERE id IN (SELECT value FROM json_each(?1)))",
    )
      .bind(JSON.stringify(ids))
      .all()
    const jobRows = new Map<string, any>(jobs.results.map((r: any) => [r.recording_id, r]))
    // Resume bounded background checkpoints without requiring the audio again.
    for (const row of results
      .filter(
        (r: any) =>
          !['done', 'legacy', 'uncertain'].includes(r.backup_step) && r.backup_until < Date.now(),
      )
      .slice(0, 4))
      ctx.waitUntil(backup(env, row.recording_id))
    return json({
      uploads: ids.map((id) => {
        const row = rows.get(id)
        return {
          id,
          status: row ? 'saved' : 'missing',
          error: null,
          ...(row ? backupState(env, row) : { backup_status: null, backup_saved: false }),
          backup_step: row?.backup_step ?? null,
          backup_error: row?.backup_error ?? null,
          transcription: jobView(jobRows.get(row?.recording_id)),
        }
      }),
    })
  }

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
        if (!Number.isFinite(time)) throw new ApiError('Invalid date range')
        clauses.push(`r.${col}${op}?`)
        args.push(time)
        if (param === 'to') {
          clauses.push('r.sort_time<?')
          args.push(time)
        }
        if (param === 'from') {
          const overlap = await env.DB.prepare(
            'SELECT 1 FROM recordings WHERE finished_at>? LIMIT 1',
          )
            .bind(time)
            .first()
          if (!overlap) return json({ results: [], next_cursor: null })
        }
      }
    }
    if (url.searchParams.get('starred') === '1') clauses.push('r.starred=1')
    const cursor = url.searchParams.get('cursor')
    if (cursor) {
      const c = JSON.parse(atob(cursor))
      if (!Number.isFinite(c.time) || typeof c.id !== 'string') throw new ApiError('Invalid cursor')
      clauses.push('(r.sort_time,r.id)<(?,?)')
      args.push(c.time, c.id)
    }
    const { results } = await env.DB.prepare(
      `SELECT r.id,r.title,r.recorded_at,r.finished_at,r.duration_ms,r.status,r.starred,r.revision,r.backup_revision,r.backup_until,r.backup_step,r.backup_error,r.audio_key IS NOT NULL AS has_audio,(SELECT json_object('id',j.id,'status',j.status,'stage',j.stage,'progress',j.progress,'detail',json(j.progress_detail),'attempt',j.attempt,'error',j.error,'updated_at',j.updated_at) FROM transcription_jobs j WHERE j.recording_id=r.id AND j.mode='standard') AS transcription_json,substr(r.text,1,240) AS preview FROM recordings r${join}${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ORDER BY r.sort_time DESC,r.id DESC LIMIT ?`,
    )
      .bind(...args, limit + 1)
      .all()
    const last = results[limit - 1]
    return json({
      results: results.slice(0, limit).map((r: any) => ({
        ...r,
        ...backupState(env, r),
        transcription: r.transcription_json ? JSON.parse(r.transcription_json) : null,
        transcription_json: undefined,
      })),
      next_cursor:
        results.length > limit
          ? btoa(JSON.stringify({ time: last.recorded_at ?? 0, id: last.id }))
          : null,
    })
  }
  const match = path.match(
    /^\/api\/recordings\/([a-zA-Z0-9-]+)(?:\/(audio|manifest|backup|transcript|transcription|resync|status|transcribe|detailed-transcription|long-transcription))?$/,
  )
  if (match) {
    const [, id, action] = match
    if (action === 'status' && method === 'GET') {
      const status =
        await env.DB.prepare(`SELECT r.id,r.revision,r.status,r.detailed_status,r.long_status,r.backup_revision,r.backup_until,r.backup_step,r.backup_error,r.audio_key IS NOT NULL AS has_audio,r.edited_at AS updated_at,
        (SELECT json_object('id',j.id,'recording_id',j.recording_id,'mode',j.mode,'status',j.status,'stage',j.stage,'progress',j.progress,'detail',json(j.progress_detail),'attempt',j.attempt,'error',j.error,'lease_until',j.lease_until,'updated_at',j.updated_at,'available_at',j.available_at) FROM transcription_jobs j WHERE j.recording_id=r.id AND mode='standard') AS transcription_json,
        (SELECT json_object('id',j.id,'recording_id',j.recording_id,'mode',j.mode,'status',j.status,'stage',j.stage,'progress',j.progress,'detail',json(j.progress_detail),'attempt',j.attempt,'error',j.error,'lease_until',j.lease_until,'updated_at',j.updated_at,'available_at',j.available_at) FROM transcription_jobs j WHERE j.recording_id=r.id AND mode='detailed') AS detailed_json,
        (SELECT json_object('id',j.id,'recording_id',j.recording_id,'mode',j.mode,'status',j.status,'stage',j.stage,'progress',j.progress,'detail',json(j.progress_detail),'attempt',j.attempt,'error',j.error,'lease_until',j.lease_until,'updated_at',j.updated_at,'available_at',j.available_at) FROM transcription_jobs j WHERE j.recording_id=r.id AND mode='long') AS long_json
        FROM recordings r WHERE r.id=?`)
          .bind(id)
          .first()
      if (!status) return json({ error: 'Recording not found' }, 404)
      return json({
        ...status,
        ...backupState(env, status),
        has_audio: !!status.has_audio,
        transcription: status.transcription_json ? JSON.parse(status.transcription_json) : null,
        detailed_transcription: status.detailed_json ? JSON.parse(status.detailed_json) : null,
        transcription_json: undefined,
        detailed_json: undefined,
        long_transcription: status.long_json ? JSON.parse(status.long_json) : null,
        long_json: undefined,
      })
    }
    let row = await env.DB.prepare('SELECT * FROM recordings WHERE id=?').bind(id).first()
    if (!row) return json({ error: 'Recording not found' }, 404)
    if (action === 'manifest' && method === 'GET') return json(await loadManifest(env, row))
    if (['transcription', 'transcribe'].includes(action) && method === 'POST') {
      if (!row.audio_key)
        throw new ApiError('Recording audio must be imported first', 409, 'audio_unavailable')
      const data = request.body ? await body(request, 4096) : {}
      if (data.retry !== undefined && typeof data.retry !== 'boolean')
        throw new ApiError('retry must be a boolean')
      return json(
        {
          transcription: jobView(
            await enqueue(env, id, 'standard', data.retry === true || row.status === 'Failed'),
          ),
        },
        202,
      )
    }
    if (
      ['detailed-transcription', 'long-transcription'].includes(action) &&
      ['GET', 'POST'].includes(method)
    ) {
      if (action === 'long-transcription' && role !== 'owner')
        return json({ error: 'Owner access required' }, 403)
      const data = method === 'POST' && request.body ? await body(request, 4096) : {}
      if (data.retry !== undefined && typeof data.retry !== 'boolean')
        throw new ApiError('retry must be a boolean')
      return json(
        await detailedTranscription(
          env,
          ctx,
          row,
          method === 'POST',
          data.retry === true,
          action === 'long-transcription' ? 'long' : 'detailed',
        ),
        method === 'POST' ? 202 : 200,
      )
    }
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
      const object = await env.BUCKET.get(row.audio_key, range ? { range: request.headers } : {})
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
      if (!env.NOTION_TOKEN || !env.NOTION_DATA_SOURCE_ID)
        throw new ApiError('Notion backup is not configured', 503, 'backup_not_configured')
      if (!row.audio_key)
        throw new ApiError(
          'Import the original audio before backing up this recording',
          409,
          'audio_unavailable',
        )
      await env.DB.prepare('UPDATE recordings SET backup_next_attempt=0 WHERE id=?').bind(id).run()
      const options = request.headers.get('content-type')?.includes('application/json')
        ? await body(request, 4096)
        : {}
      if (options.retry_creation !== undefined && typeof options.retry_creation !== 'boolean')
        throw new ApiError('retry_creation must be a boolean')
      // Reconcile and optionally recreate under the same lease as automatic backups.
      ctx.waitUntil(backup(env, id, options.retry_creation === true))
      return json({ accepted: true }, 202)
    }
    if (!action && method === 'PATCH') {
      const data = await body(request, 4096)
      if (data.title !== undefined && (typeof data.title !== 'string' || data.title.length > 200))
        throw new ApiError('Invalid title')
      if (data.starred !== undefined && typeof data.starred !== 'boolean')
        throw new ApiError('Invalid starred flag')
      const fields: string[] = [],
        values: any[] = []
      if (data.title !== undefined) {
        fields.push('title=?')
        values.push(data.title)
      }
      if (data.starred !== undefined) {
        fields.push('starred=?')
        values.push(Number(data.starred))
      }
      if (!fields.length) throw new ApiError('Provide title or starred')
      const updated = await env.DB.prepare(
        `UPDATE recordings SET ${fields.join(',')},primary_owned=1,revision=revision+1,edited_at=? WHERE id=? RETURNING revision,edited_at AS updated_at,title,starred`,
      )
        .bind(...values, new Date().toISOString(), id)
        .first()
      if (!updated) throw new ApiError('Recording not found', 404, 'not_found')
      ctx.waitUntil(backup(env, id))
      return json({ saved: true, ...updated, starred: !!updated.starred })
    }
    if (!action && method === 'GET') {
      const jobs = await env.DB.prepare('SELECT * FROM transcription_jobs WHERE recording_id=?')
        .bind(id)
        .all()
      return json({
        transcription: jobView(jobs.results.find((j: any) => j.mode === 'standard')),
        detailed_transcription: jobView(jobs.results.find((j: any) => j.mode === 'detailed')),
        long_transcription: jobView(jobs.results.find((j: any) => j.mode === 'long')),
        segments: JSON.parse(row.transcript_segments),
        detailed_segments: JSON.parse(row.detailed_segments),
        id: row.id,
        updated_at: row.edited_at,
        title: row.title,
        recorded_at: row.recorded_at,
        duration_ms: row.duration_ms ?? row.finished_at - row.recorded_at,
        status: row.status,
        text: row.text,
        detailed_status: row.detailed_status,
        detailed_text: row.detailed_text,
        detailed_error: row.detailed_error,
        long_status: row.long_status,
        long_text: row.long_text,
        long_error: row.long_error,
        starred: !!row.starred,
        has_audio: !!row.audio_key,
        ...backupState(env, row),
        backup_step: row.backup_step,
        backup_error: row.backup_error,
        backup_attempts: row.backup_attempts,
        backup_next_attempt: row.backup_next_attempt,
        backup_configured: !!(env.NOTION_TOKEN && env.NOTION_DATA_SOURCE_ID),
        url: row.url,
      })
    }
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
        throw new ApiError('Device name required')
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
      if (path === '/api/transcriber/completed' && request.method === 'POST') {
        if (!(await webhookAuthorized(request, env.UOMI_WEBHOOK_SECRET)))
          return json({ error: 'Authentication required' }, 401)
        const data = await body(request, 4096)
        if (data.mode !== undefined && !['standard', 'detailed'].includes(data.mode))
          throw Error('Invalid transcription mode')
        return json(await refreshTranscript(env, data.pageId))
      }
      if (path === '/health') return json({ ok: true })
      if (path === '/mcp') {
        const role = await authorize(request, env)
        if (!role) return json({ error: 'Authentication required' }, 401)
        if (role === 'worker') return json({ error: 'Worker credentials cannot use MCP' }, 403)
        const origin = request.headers.get('Origin')
        if (
          request.method !== 'GET' &&
          visitor(request) &&
          origin &&
          origin !== new URL(request.url).origin
        )
          return json({ error: 'Cross-origin write rejected' }, 403)
        if (request.method === 'POST') {
          const rpc: any = await request.clone().json()
          if (rpc.method === 'tools/call' && rpc.params?.name === 'search_transcripts')
            await requireSearchReady(env)
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
                      configured: !!(env.DB && env.BUCKET),
                      backup_configured: !!(env.NOTION_TOKEN && env.NOTION_DATA_SOURCE_ID),
                      source: 'D1/R2',
                      ...count,
                      sync: state,
                      optimization,
                      transcriber: {
                        transport: 'api',
                        worker_auth_configured: !!(
                          env.UOMI_WORKER_SECRET || env.UOMI_WEBHOOK_SECRET
                        ),
                        jobs: (
                          await env.DB.prepare(
                            'SELECT mode,status,count(*) AS count FROM transcription_jobs GROUP BY mode,status',
                          ).all()
                        ).results,
                      },
                      storage: {
                        ...(await storageDiagnostics(env)),
                        database_bytes: storage.meta?.size_after ?? null,
                        ...storage.results[0],
                        ...fts,
                        note: 'Database bytes are physical D1 size. Component bytes are payload only, excluding SQLite page/B-tree overhead; FTS data may include pending merge segments.',
                        daily: daily.results,
                      },
                      limitations: [
                        'Recording-level time ranges; no word timestamps.',
                        'Run sync_index to import historical Notion recordings; existing primary records remain unchanged.',
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
        return mcp.fetch(request, env, { role })
      }
      if (!path.startsWith('/api/'))
        return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 })
      const role = await authorize(request, env)
      if (!role) return json({ error: 'Authentication required' }, 401)
      if (
        role === 'worker' &&
        !(
          path === '/api/jobs' ||
          path.startsWith('/api/jobs/') ||
          path === '/api/migrations/notion' ||
          (request.method === 'GET' &&
            /^\/api\/recordings\/[a-zA-Z0-9-]+\/(audio|manifest)$/.test(path))
        )
      )
        return json(
          {
            error: 'Worker credentials only permit transcription jobs and audio/manifest reads',
            code: 'worker_scope_required',
          },
          403,
        )
      if (request.method !== 'GET' && visitor(request)) {
        const origin = request.headers.get('Origin')
        if (origin && origin !== new URL(request.url).origin)
          return json({ error: 'Cross-origin write rejected' }, 403)
      }

      return await api(request, env, ctx, role)
    } catch (e) {
      const requestId = crypto.randomUUID()
      const message = String((e as Error).message).slice(0, 4000)
      console.error(
        JSON.stringify({
          event: 'api_error',
          request_id: requestId,
          path: new URL(request.url).pathname,
          error: message,
          stack: (e as Error).stack,
        }),
      )
      return json(
        {
          error: message,
          code: e instanceof ApiError ? e.code : 'request_failed',
          request_id: requestId,
        },
        e instanceof ApiError ? e.status : e instanceof SyntaxError ? 400 : 500,
      )
    }
  },
}
