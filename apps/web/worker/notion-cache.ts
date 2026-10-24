import { enqueue, enqueueLongDefault, validateSegments } from './jobs.ts'
import { normalizeSearch } from './search.js'
import { saveManifest } from './manifest.ts'
import { Buffer } from 'buffer'
import { ranges } from './source-ranges.ts'
import { NotionStore, httpTransport, validateManifest } from '@uomi/notion'
const text = (values: any[]) =>
  (values ?? []).map((v) => v.plain_text ?? v.text?.content ?? '').join('')
async function hash(value: BufferSource) {
  return Buffer.from(await crypto.subtle.digest('SHA-256', value)).toString('hex')
}
export async function attachment(url: string, max: number) {
  if (new URL(url).protocol !== 'https:') throw Error('Invalid attachment URL')
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(12000) })
  if (!response.ok || !response.body) throw Error(`Notion attachment HTTP ${response.status}`)
  const reader = response.body.getReader()
  let size = 0
  const parts = []
  try {
    for (;;) {
      const p = await reader.read()
      if (p.done) break
      size += p.value.length
      if (size > max) throw Error('Notion attachment is too large')
      parts.push(p.value)
    }
  } finally {
    await reader.cancel()
  }
  return Buffer.concat(parts)
}
export async function readDetailedTranscript(store: NotionStore, page: any) {
  const p = page.properties
  let transcript = text(p['Detailed preview']?.rich_text),
    segments: ReturnType<typeof validateSegments> = []
  if (p['Detailed transcript']?.files?.[0]?.file?.url) {
    const data = JSON.parse(
      (await attachment(store.fileUrl(page, 'Detailed transcript'), 1024 * 1024)).toString(),
    )
    if (
      data.schema !== 'uomi.transcript.v1' ||
      typeof data.text !== 'string' ||
      data.provider !== 'codex'
    )
      throw Error('Invalid detailed transcript attachment')
    transcript = data.text
    segments = validateSegments(data.segments, null)
  }
  return {
    detailed_status: p['Detailed status']?.select?.name ?? null,
    detailed_text: transcript,
    detailed_segments: segments,
    detailed_error: text(p['Detailed error']?.rich_text),
  }
}
export async function readLongTranscript(store: NotionStore, page: any) {
  const p = page.properties
  let transcript = text(p['Long preview']?.rich_text)
  if (p['Long transcript']?.files?.[0]?.file?.url) {
    const data = JSON.parse(
      (await attachment(store.fileUrl(page, 'Long transcript'), 4 * 1024 * 1024)).toString(),
    )
    if (
      data.schema !== 'uomi.transcript.v1' ||
      data.mode !== 'long' ||
      typeof data.text !== 'string' ||
      data.text.length > 1000000
    )
      throw Error('Invalid long transcript attachment')
    transcript = data.text
  }
  return {
    status: p['Long status']?.select?.name ?? null,
    text: transcript,
    error: text(p['Long error']?.rich_text),
  }
}
// Fill missing original files without allowing an import to replace primary edits.
async function hydrateMissingAudio(env: any, store: NotionStore, page: any, old: any) {
  const id = old.id,
    p = page.properties
  const missing = ['Audio', 'Manifest'].filter((name) => !p[name]?.files?.[0]?.file?.url)
  if (page.archived || page.in_trash || missing.length)
    return {
      id,
      audio_imported: false,
      warning: 'missing_audio',
      missing_source_files: missing,
      ...(page.archived || page.in_trash ? { source_archived: true } : {}),
    }
  const manifest = JSON.parse(
    (await attachment(store.fileUrl(page, 'Manifest'), 6 * 1024 * 1024)).toString(),
  )
  validateManifest(manifest)
  const spans = ranges(manifest.frameIds.map((id: string) => ({ id })))
  const audio = await attachment(store.fileUrl(page, 'Audio'), 20 * 1024 * 1024)
  if ((await hash(audio)) !== manifest.sha256)
    throw Error('Notion audio hash does not match its manifest')
  const key = `audio/${manifest.sha256}.ogg`,
    manifestKey = await saveManifest(env, manifest)
  await env.BUCKET.put(key, audio, {
    httpMetadata: { contentType: 'audio/ogg' },
    customMetadata: { sha256: manifest.sha256 },
  })
  // Update audio last: every statement observes the same missing-audio condition
  // within this transaction. A concurrent hydration that won earlier makes all
  // three statements no-ops, including source claim replacement.
  const result = await env.DB.batch([
    env.DB.prepare(
      'DELETE FROM source_ranges WHERE recording_id=(SELECT rid FROM recordings WHERE id=? AND audio_key IS NULL AND notion_edited IS NOT NULL)',
    ).bind(id),
    env.DB.prepare(`INSERT INTO source_ranges SELECT ?,json_extract(value,'$.prefix'),json_extract(value,'$.start'),json_extract(value,'$.end'),
      (SELECT rid FROM recordings WHERE id=?) FROM json_each(?) WHERE EXISTS(SELECT 1 FROM recordings WHERE id=? AND audio_key IS NULL AND notion_edited IS NOT NULL)`).bind(
      manifest.deviceId,
      id,
      JSON.stringify(spans),
      id,
    ),
    env.DB.prepare(
      'UPDATE recordings SET audio_key=?,audio_sha=?,manifest_key=?,manifest_gzip=NULL WHERE id=? AND audio_key IS NULL AND notion_edited IS NOT NULL',
    ).bind(key, manifest.sha256, manifestKey, id),
  ])
  const hydrated = !!result[2].meta.changes
  if (hydrated && old.status !== 'Completed') await enqueue(env, id)
  if (hydrated) await enqueueLongDefault(env, id)
  return {
    id,
    cached: hydrated,
    hydrated,
    audio_imported: hydrated,
    ...(!hydrated ? { skipped: 'audio-already-present' } : {}),
  }
}
export async function cachePage(env: any, page: any) {
  const store = new NotionStore(httpTransport(env.NOTION_TOKEN), env.NOTION_DATA_SOURCE_ID),
    p = page.properties,
    canonicalId = text(p['Recording ID']?.rich_text) || page.id
  let old = await env.DB.prepare(
    'SELECT * FROM recordings WHERE backup_page=? OR id=? OR id=? LIMIT 1',
  )
    .bind(page.id, canonicalId, page.id)
    .first()
  const id = old?.id ?? canonicalId
  // Import is one-way: backups must never overwrite or delete primary edits/results.
  const refreshBaseline =
    old?.notion_edited != null && old.revision === 0 && old.notion_import_version === 0
  if (old?.primary_owned && old.notion_edited != null && !old.audio_key && !refreshBaseline)
    return hydrateMissingAudio(env, store, page, old)
  if (old?.primary_owned && !refreshBaseline)
    return {
      id,
      skipped: 'primary-owned',
      ...(!old.audio_key ? { audio_imported: false, warning: 'missing_audio' } : {}),
    }
  if (page.archived || page.in_trash) {
    if (old?.primary_owned) {
      await env.DB.prepare(
        'UPDATE recordings SET notion_import_version=1,backup_revision=revision WHERE id=? AND notion_edited IS NOT NULL AND revision=0 AND notion_import_version=0',
      )
        .bind(id)
        .run()
      return {
        id,
        skipped: 'archived-primary-preserved',
        ...(!old.audio_key
          ? { audio_imported: false, warning: 'missing_audio', source_archived: true }
          : {}),
      }
    }
    await env.DB.batch([
      env.DB.prepare(
        'DELETE FROM source_ranges WHERE recording_id=(SELECT rid FROM recordings WHERE id=? AND primary_owned=0)',
      ).bind(id),
      env.DB.prepare('DELETE FROM recordings WHERE id=? AND primary_owned=0').bind(id),
    ])
    return { id, removed: true }
  }
  if (
    old &&
    old.notion_edited === page.last_edited_time &&
    old.audio_key &&
    (await env.BUCKET.head(old.audio_key)) &&
    (old.manifest_gzip || (old.manifest_key && (await env.BUCKET.head(old.manifest_key))))
  ) {
    await env.DB.prepare(
      'UPDATE recordings SET primary_owned=1,notion_import_version=1,backup_revision=revision WHERE id=? AND (primary_owned=0 OR (notion_edited IS NOT NULL AND revision=0 AND notion_import_version=0))',
    )
      .bind(id)
      .run()
    return { id, unchanged: true }
  }
  let audioKey: string | null = old?.audio_key ?? null,
    sha: string | null = old?.audio_sha ?? null,
    manifestKey: string | null = old?.manifest_key ?? null
  let sourceSpans: ReturnType<typeof ranges> = []
  const manifestUrl = p.Manifest?.files?.[0]?.file?.url
  const sourceFilesPresent = !!(manifestUrl && p.Audio?.files?.[0]?.file?.url)
  if (sourceFilesPresent) {
    const manifest = JSON.parse(
      (await attachment(store.fileUrl(page, 'Manifest'), 6 * 1024 * 1024)).toString(),
    )
    validateManifest(manifest)
    sourceSpans = ranges(manifest.frameIds.map((id: string) => ({ id })))
    const audio = await attachment(store.fileUrl(page, 'Audio'), 20 * 1024 * 1024)
    if ((await hash(audio)) !== manifest.sha256)
      throw Error('Notion audio hash does not match its manifest')
    sha = manifest.sha256
    audioKey = `audio/${sha}.ogg`
    await env.BUCKET.put(audioKey, audio, {
      httpMetadata: { contentType: 'audio/ogg' },
      customMetadata: { sha256: sha },
    })
    manifestKey = await saveManifest(env, manifest)
  }
  let transcript = text(p['Transcript preview']?.rich_text),
    segments: ReturnType<typeof validateSegments> = []
  if (p.Transcript?.files?.[0]?.file?.url) {
    const data = JSON.parse(
      (await attachment(store.fileUrl(page, 'Transcript'), 1024 * 1024)).toString(),
    )
    if (data.schema !== 'uomi.transcript.v1' || typeof data.text !== 'string')
      throw Error('Invalid transcript attachment')
    transcript = data.text
    segments = validateSegments(data.segments, null)
  }
  const detailed = await readDetailedTranscript(store, page)
  const long = await readLongTranscript(store, page)
  const start = p.recorded_at_ms?.number ?? Date.parse(p['Recorded at']?.date?.start),
    duration = (p['Duration (s)']?.number ?? 0) * 1000,
    finish = p.record_finished_at_ms?.number ?? start + duration,
    title = text(Object.values<any>(p).find((v) => v.type === 'title')?.title ?? p.Name?.title),
    starred = Number(p.Starred?.checkbox ?? false),
    status = p.Status?.select?.name ?? 'Pending'
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO recordings(id,recorded_at,finished_at,edited_at,device,status,url,text,audio_key,audio_sha,duration_ms,manifest_key,title,starred,backup_step,backup_page,notion_edited,search_text,search_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'done',?,?,?,1) ON CONFLICT(id) DO UPDATE SET recorded_at=excluded.recorded_at,finished_at=excluded.finished_at,edited_at=excluded.edited_at,device=excluded.device,status=excluded.status,url=excluded.url,text=excluded.text,audio_key=excluded.audio_key,audio_sha=excluded.audio_sha,duration_ms=excluded.duration_ms,manifest_key=excluded.manifest_key,manifest_gzip=CASE WHEN excluded.manifest_key IS NOT NULL THEN NULL ELSE recordings.manifest_gzip END,title=excluded.title,starred=excluded.starred,backup_step='done',backup_page=excluded.backup_page,notion_edited=excluded.notion_edited,search_text=excluded.search_text,search_version=1 WHERE (recordings.primary_owned=0 OR (recordings.notion_edited IS NOT NULL AND recordings.revision=0 AND recordings.notion_import_version=0))",
    ).bind(
      id,
      Number.isFinite(start) ? start : null,
      Number.isFinite(finish) ? finish : null,
      page.last_edited_time,
      text(p.Device?.rich_text),
      status,
      page.url ?? '',
      transcript,
      audioKey,
      sha,
      duration,
      manifestKey,
      title,
      starred,
      page.id,
      page.last_edited_time,
      normalizeSearch(transcript),
    ),
    env.DB.prepare(
      'UPDATE recordings SET detailed_status=?,detailed_text=?,detailed_error=?,transcript_segments=?,detailed_segments=?,long_status=?,long_text=?,long_error=? WHERE id=? AND (primary_owned=0 OR (notion_edited IS NOT NULL AND revision=0 AND notion_import_version=0))',
    ).bind(
      detailed.detailed_status,
      detailed.detailed_text,
      detailed.detailed_error,
      JSON.stringify(segments),
      JSON.stringify(detailed.detailed_segments),
      long.status,
      long.text,
      long.error,
      id,
    ),
    ...(sourceFilesPresent
      ? [
          env.DB.prepare(
            'DELETE FROM source_ranges WHERE recording_id=(SELECT rid FROM recordings WHERE id=? AND (primary_owned=0 OR (notion_edited IS NOT NULL AND revision=0 AND notion_import_version=0)))',
          ).bind(id),
          env.DB.prepare(`INSERT INTO source_ranges SELECT ?,json_extract(value,'$.prefix'),json_extract(value,'$.start'),json_extract(value,'$.end'),
      (SELECT rid FROM recordings WHERE id=?) FROM json_each(?) WHERE EXISTS(SELECT 1 FROM recordings WHERE id=? AND (primary_owned=0 OR (notion_edited IS NOT NULL AND revision=0 AND notion_import_version=0)))`).bind(
            text(p.Device?.rich_text),
            id,
            JSON.stringify(sourceSpans),
            id,
          ),
        ]
      : []),
    env.DB.prepare(
      'UPDATE recordings SET primary_owned=1,notion_import_version=1,backup_revision=revision WHERE id=? AND (primary_owned=0 OR (notion_edited IS NOT NULL AND revision=0 AND notion_import_version=0))',
    ).bind(id),
  ])
  if (audioKey && status !== 'Completed') await enqueue(env, id)
  if (audioKey) await enqueueLongDefault(env, id)
  return {
    id,
    cached: true,
    audio_imported: sourceFilesPresent,
    ...(!sourceFilesPresent
      ? {
          warning: 'missing_audio',
          missing_source_files: ['Audio', 'Manifest'].filter(
            (name) => !p[name]?.files?.[0]?.file?.url,
          ),
        }
      : {}),
  }
}
export async function resync(env: any, reset = false) {
  if (!env.NOTION_TOKEN || !env.NOTION_DATA_SOURCE_ID)
    throw Error('Notion credentials are not configured')
  await env.DB.prepare(
    "INSERT OR IGNORE INTO resync_state(id,since) VALUES(1,'1970-01-01T00:00:00.000Z')",
  ).run()
  const now = Date.now(),
    lock = await env.DB.prepare(
      'UPDATE resync_state SET lease_until=? WHERE id=1 AND lease_until<?',
    )
      .bind(now + 120000, now)
      .run()
  if (!lock.meta.changes) throw Error('Notion resync is already running')
  try {
    if (reset)
      await env.DB.prepare(
        "UPDATE resync_state SET cursor=NULL,since='1970-01-01T00:00:00.000Z',started=NULL WHERE id=1",
      ).run()
    const state = await env.DB.prepare('SELECT * FROM resync_state WHERE id=1').first(),
      started = state.started ?? new Date(now).toISOString()
    const progress: { token?: string; windows: number[][]; archived: boolean } = state.cursor
      ? JSON.parse(state.cursor)
      : { windows: [[0, Date.parse(started) + 86400000]], archived: false }
    const [lower, upper] = progress.windows[0]
    const store = new NotionStore(
      httpTransport(env.NOTION_TOKEN, ((url: any, init: any) =>
        fetch(url, { ...init, signal: AbortSignal.timeout(12000) })) as typeof fetch),
      env.NOTION_DATA_SOURCE_ID,
    )
    const result = await store.transport({
      path: `/data_sources/${await store.source()}/query`,
      method: 'POST',
      body: {
        page_size: 1,
        ...(progress.token ? { start_cursor: progress.token } : {}),
        ...(progress.archived ? { is_archived: true } : {}),
        filter: {
          and: [
            { timestamp: 'last_edited_time', last_edited_time: { on_or_after: state.since } },
            {
              timestamp: 'created_time',
              created_time: { on_or_after: new Date(lower).toISOString() },
            },
            { timestamp: 'created_time', created_time: { before: new Date(upper).toISOString() } },
          ],
        },
        sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
      },
    })
    const updates = []
    if (result.request_status?.type === 'incomplete') {
      if (upper - lower <= 1)
        throw Error('Notion truncated a single creation timestamp. Cache coverage is incomplete.')
      const middle = Math.floor((lower + upper) / 2)
      progress.windows.splice(0, 1, [lower, middle], [middle, upper])
      delete progress.token
    } else {
      for (const page of result.results ?? []) updates.push(await cachePage(env, page))
      if (result.has_more) {
        if (!result.next_cursor) throw Error('Notion pagination did not return a cursor')
        progress.token = result.next_cursor
      } else {
        progress.windows.shift()
        delete progress.token
      }
    }
    if (!progress.windows.length && !progress.archived) {
      progress.archived = true
      progress.windows = [[0, Date.parse(started) + 86400000]]
    }
    const hasMore = progress.windows.length > 0
    await env.DB.prepare('UPDATE resync_state SET cursor=?,since=?,started=? WHERE id=1')
      .bind(
        hasMore ? JSON.stringify(progress) : null,
        hasMore ? state.since : new Date(Date.parse(started) - 60000).toISOString(),
        hasMore ? started : null,
      )
      .run()
    await env.DB.prepare('UPDATE resync_state SET last_error=NULL,updated_at=? WHERE id=1')
      .bind(Date.now())
      .run()
    return { processed: updates.length, has_more: hasMore, updates }
  } catch (e) {
    await env.DB.prepare('UPDATE resync_state SET last_error=?,updated_at=? WHERE id=1')
      .bind(String((e as Error).message).slice(0, 4000), Date.now())
      .run()
    throw e
  } finally {
    await env.DB.prepare('UPDATE resync_state SET lease_until=0 WHERE id=1').run()
  }
}
