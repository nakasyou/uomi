import { httpTransport, NotionStore } from '@uomi/notion'
import { normalizeSearch } from './search.js'
import { attachment } from './notion-cache.ts'
const plain = (values: any[]) =>
  (values ?? []).map((v) => v.plain_text ?? v.text?.content ?? '').join('')
export function validPageId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    /^(?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i.test(id)
  )
}
export async function webhookAuthorized(request: Request, secret?: string) {
  if (!secret || secret.length < 24) return false
  const supplied = request.headers.get('X-Uomi-Webhook-Secret') ?? ''
  const hash = (s: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  const [a, b] = await Promise.all([hash(supplied), hash(secret)])
  const x = new Uint8Array(a),
    y = new Uint8Array(b)
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}
export async function notifyTranscriber(env: any, id: string, force = false) {
  const row = await env.DB.prepare(
    'SELECT rid,backup_page,status,backup_step FROM recordings WHERE id=?',
  )
    .bind(id)
    .first()
  if (!row || row.backup_step !== 'done') return { skipped: true }
  if (row.status === 'Completed') {
    await env.DB.prepare('DELETE FROM transcriber_notifications WHERE recording_id=?')
      .bind(row.rid)
      .run()
    return { skipped: true }
  }
  await env.DB.prepare('INSERT OR IGNORE INTO transcriber_notifications(recording_id) VALUES(?)')
    .bind(row.rid)
    .run()
  if (force)
    await env.DB.prepare(
      'UPDATE transcriber_notifications SET delivered_at=NULL,next_attempt=0 WHERE recording_id=?',
    )
      .bind(row.rid)
      .run()
  if (
    !env.TRANSCRIBER_WEBHOOK_URL ||
    !env.UOMI_WEBHOOK_SECRET ||
    env.UOMI_WEBHOOK_SECRET.length < 24
  )
    return { configured: false }
  const endpoint = new URL(env.TRANSCRIBER_WEBHOOK_URL)
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password)
    throw Error('Transcriber webhook must be an HTTPS URL without embedded credentials')
  const now = Date.now()
  const lock = await env.DB.prepare(
    'UPDATE transcriber_notifications SET lease_until=? WHERE recording_id=? AND delivered_at IS NULL AND next_attempt<=? AND lease_until<?',
  )
    .bind(now + 15000, row.rid, now, now)
    .run()
  if (!lock.meta.changes) return { skipped: true }
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(4000),
      headers: {
        Authorization: `Bearer ${env.UOMI_WEBHOOK_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pageId: row.backup_page }),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw Error(`Transcriber webhook HTTP ${response.status}`)
    }
    const receipt: any = await response.json()
    if (typeof receipt.accepted !== 'boolean') throw Error('Invalid transcriber receipt')
    await env.DB.prepare(
      'UPDATE transcriber_notifications SET delivered_at=?,lease_until=0,error=NULL WHERE recording_id=?',
    )
      .bind(Date.now(), row.rid)
      .run()
    return { delivered: true }
  } catch (error) {
    await env.DB.prepare(
      'UPDATE transcriber_notifications SET attempts=attempts+1,next_attempt=?+min(300000,1000*(1<<min(attempts,8))),lease_until=0,error=? WHERE recording_id=?',
    )
      .bind(Date.now(), String((error as Error).message).slice(0, 200), row.rid)
      .run()
    return { delivered: false }
  }
}
export async function flushNotifications(env: any) {
  if (!env.TRANSCRIBER_WEBHOOK_URL || !env.UOMI_WEBHOOK_SECRET) return
  const row = await env.DB.prepare(
    'SELECT r.id FROM transcriber_notifications n JOIN recordings r ON r.rid=n.recording_id WHERE n.delivered_at IS NULL AND n.next_attempt<=? AND n.lease_until<? ORDER BY n.next_attempt LIMIT 1',
  )
    .bind(Date.now(), Date.now())
    .first()
  if (row) await notifyTranscriber(env, row.id)
}
export async function refreshTranscript(env: any, id: string) {
  if (!validPageId(id)) throw Error('Invalid Notion page ID')
  const store = new NotionStore(
    httpTransport(env.NOTION_TOKEN, ((url: any, init: any) =>
      fetch(url, { ...init, signal: AbortSignal.timeout(6000) })) as typeof fetch),
    env.NOTION_DATA_SOURCE_ID,
  )
  const page = await store.page(id)
  if (!(await store.owns(page))) throw Error('Page is outside the configured source')
  if (page.archived || page.in_trash) throw Error('Canonical page is archived; run source resync')
  const p = page.properties
  if (p.Status?.select?.name !== 'Completed') throw Error('Canonical transcript is not complete')
  if (!p.Transcript?.files?.[0]?.file?.url)
    throw Error('Canonical transcript attachment is missing')
  const value = JSON.parse(
    (await attachment(store.fileUrl(page, 'Transcript'), 1024 * 1024)).toString(),
  )
  if (value.schema !== 'uomi.transcript.v1' || typeof value.text !== 'string')
    throw Error('Invalid canonical transcript')
  const canonical = plain(p['Recording ID']?.rich_text) || page.id
  const old = await env.DB.prepare(
    "SELECT id,backup_step,primary_owned FROM recordings WHERE backup_page=? OR replace(backup_page,'-','')=? OR id=? OR id=? LIMIT 1",
  )
    .bind(page.id, id.replace(/-/g, ''), canonical, page.id)
    .first()
  if (old?.primary_owned) return { saved: true, id: old.id, skipped: 'primary-owned' }
  if (old && !['done', 'legacy'].includes(old.backup_step))
    throw Error('Source save is still being verified; retry completion notification')
  const recordId = old?.id ?? canonical
  const start = p.recorded_at_ms?.number ?? Date.parse(p['Recorded at']?.date?.start)
  const duration = (p['Duration (s)']?.number ?? 0) * 1000
  const end = p.record_finished_at_ms?.number ?? start + duration
  const title = plain(Object.values<any>(p).find((v) => v.type === 'title')?.title ?? p.Name?.title)
  await env.DB.prepare(
    `INSERT INTO recordings(id,recorded_at,finished_at,edited_at,device,status,url,text,title,starred,duration_ms,backup_step,backup_page,search_text,search_version) VALUES(?,?,?,?,?,'Completed',?,?,?,?,?,'done',?,?,1) ON CONFLICT(id) DO UPDATE SET status='Completed',text=excluded.text,search_text=excluded.search_text,search_version=1,edited_at=excluded.edited_at,notion_edited=NULL,title=excluded.title,starred=excluded.starred`,
  )
    .bind(
      recordId,
      Number.isFinite(start) ? start : null,
      Number.isFinite(end) ? end : null,
      page.last_edited_time,
      plain(p.Device?.rich_text),
      page.url ?? '',
      value.text,
      title,
      Number(p.Starred?.checkbox ?? false),
      duration,
      page.id,
      normalizeSearch(value.text),
    )
    .run()
  await env.DB.prepare(
    'DELETE FROM transcriber_notifications WHERE recording_id=(SELECT rid FROM recordings WHERE id=?)',
  )
    .bind(recordId)
    .run()
  return { saved: true, id: recordId }
}
