import { Database } from 'bun:sqlite'
import { mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { NotionStore, type AudioManifest } from '@uomi/notion'

// A local coordination index, not a replacement for the Notion database. It
// serializes clients and records ambiguous create intents before issuing POST.
export class ReservationCoordinator {
  private db?: Database
  private chain: Promise<unknown> = Promise.resolve()
  constructor(
    private store: NotionStore,
    private directory: string,
  ) {}
  reserve(value: unknown): Promise<{ pageId: string }> {
    const task = this.chain.then(() => this.perform(value))
    // A failed reservation must not poison later reservations; task still rejects to its caller.
    this.chain = task.catch((error) => {
      console.error(
        JSON.stringify({
          stage: 'legacy_reservation',
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    })
    return task
  }
  async close() {
    await this.chain
    this.db?.close()
  }
  private async perform(value: unknown) {
    const request = value as AudioManifest & { source?: string }
    if (
      !request ||
      !/^[a-f0-9]{64}$/.test(request.id ?? '') ||
      !/^[a-f0-9]{64}$/.test(request.sha256 ?? '') ||
      typeof request.deviceId !== 'string' ||
      request.deviceId.length > 512 ||
      !Number.isFinite(request.durationMs) ||
      request.durationMs <= 0 ||
      request.durationMs > 900000 ||
      !Array.isArray(request.frameIds) ||
      !request.frameIds.length ||
      request.frameIds.length > 45000 ||
      request.frameIds.some((id) => typeof id !== 'string' || id.length > 512) ||
      (request.capturedAt !== null && !Number.isFinite(Date.parse(request.capturedAt)))
    )
      throw Error('Invalid recording reservation.')
    const identity = request.gaps?.length
      ? { frameIds: request.frameIds, gaps: request.gaps }
      : request.frameIds
    if (createHash('sha256').update(JSON.stringify(identity)).digest('hex') !== request.id)
      throw Error('Recording identity does not match its source frames.')
    const source = await this.store.source()
    if (request.source?.replace(/-/g, '') !== source.replace(/-/g, ''))
      throw Error('Client and daemon must use the same Notion data source.')
    if (!this.db) {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      this.db = new Database(join(this.directory, 'reservations.sqlite'), { create: true })
      this.db.exec(
        'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS reservations(source TEXT,id TEXT,sha256 TEXT,page_id TEXT,PRIMARY KEY(source,id)); CREATE TABLE IF NOT EXISTS frame_claims(source TEXT,frame TEXT,recording TEXT,PRIMARY KEY(source,frame));',
      )
    }
    const db = this.db
    const saved = db
      .query('SELECT sha256,page_id FROM reservations WHERE source=? AND id=?')
      .get(source, request.id) as { sha256: string; page_id: string | null } | null
    if (saved && saved.sha256 !== request.sha256)
      throw Error('Recording identity conflicts with its reserved audio.')
    if (saved?.page_id) {
      const page = await this.store.page(saved.page_id)
      if (page.archived || page.in_trash)
        throw Error('The reserved Notion page was removed. Restore it before retrying.')
      return { pageId: page.id }
    }
    const existing = await this.store.find(request.id)
    if (saved && !existing)
      throw Error('An earlier Notion page creation is unresolved. Retry after checking Notion.')
    const conflict = db.query('SELECT recording FROM frame_claims WHERE source=? AND frame=?')
    for (const id of request.frameIds) {
      const claim = conflict.get(source, id) as { recording: string } | null
      if (claim && claim.recording !== request.id)
        throw Error(
          'Another upload owns overlapping audio. Refresh Notion and retry; an unfinished upload must resume with its original chunk.',
        )
    }
    db.transaction(() => {
      db.query('INSERT OR IGNORE INTO reservations VALUES (?,?,?,NULL)').run(
        source,
        request.id,
        request.sha256,
      )
      const put = db.query('INSERT OR IGNORE INTO frame_claims VALUES (?,?,?)')
      for (const frame of request.frameIds) put.run(source, frame, request.id)
    })()
    // The committed intent remains when the create response is lost. No other
    // client can create this ID or reserve its frames during that uncertainty.
    let page: any
    try {
      page = existing ?? (await this.store.createReservedPage(request))
    } catch (error) {
      if (/Notion HTTP (400|401|403|404|429)\b/.test(String(error)))
        db.transaction(() => {
          db.query('DELETE FROM frame_claims WHERE source=? AND recording=?').run(
            source,
            request.id,
          )
          db.query('DELETE FROM reservations WHERE source=? AND id=? AND page_id IS NULL').run(
            source,
            request.id,
          )
        })()
      throw error
    }
    db.query('UPDATE reservations SET page_id=? WHERE source=? AND id=?').run(
      page.id,
      source,
      request.id,
    )
    return { pageId: page.id }
  }
}
