import { NotionStore, httpTransport } from '@uomi/notion'
import { readDetailedTranscript } from './notion-cache.ts'

// Notion is the durable queue. Delivery of this optional wake-up is best effort.
async function notify(env: any, pageId: string) {
  if (!env.TRANSCRIBER_WEBHOOK_URL || !env.UOMI_WEBHOOK_SECRET) return
  try {
    const url = new URL(env.TRANSCRIBER_WEBHOOK_URL)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      throw Error('Invalid transcriber URL')
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.UOMI_WEBHOOK_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pageId, mode: 'detailed' }),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    })
    await response.body?.cancel()
    if (!response.ok) throw Error('Wake-up rejected')
  } catch {
    console.warn('Detailed transcription wake-up failed; Notion polling will recover the job.')
  }
}
export async function detailedTranscription(env: any, ctx: any, row: any, start: boolean) {
  if (!['done', 'legacy'].includes(row.backup_step))
    throw Error('Wait for the recording to finish saving to Notion before transcribing.')
  const store = new NotionStore(httpTransport(env.NOTION_TOKEN), env.NOTION_DATA_SOURCE_ID)
  const page = await store.page(row.backup_page ?? row.id)
  if (!(await store.owns(page)) || page.archived || page.in_trash)
    throw Error('Recording is no longer available in the configured Notion source.')
  if (start) {
    store.fileUrl(page, 'Audio')
    store.fileUrl(page, 'Manifest')
    if (page.properties.Status?.select?.name === 'Uploading')
      throw Error('Wait for the audio upload to finish.')
    const status = page.properties['Detailed status']?.select?.name
    if (!['Pending', 'Processing', 'Completed'].includes(status)) {
      await store.setup()
      const updated = await store.update(page.id, {
        'Detailed status': { select: { name: 'Pending' } },
        'Detailed error': { rich_text: [] },
        'Detailed attempts': { number: 0 },
        'Detailed retry after': { date: null },
      })
      Object.assign(page, updated)
    }
    if (page.properties['Detailed status']?.select?.name !== 'Completed')
      ctx.waitUntil(notify(env, page.id))
  }
  const result = await readDetailedTranscript(store, page)
  await env.DB.prepare(
    'UPDATE recordings SET detailed_status=?,detailed_text=?,detailed_error=? WHERE id=?',
  )
    .bind(result.detailed_status, result.detailed_text, result.detailed_error, row.id)
    .run()
  return result
}
