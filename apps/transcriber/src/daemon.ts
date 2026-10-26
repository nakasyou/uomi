import { nonEmptyAudioSegments } from './audio-segments'
import { errorDetail } from './api-worker'
import { CompletionOutbox, type SitesCallback } from './callbacks'
import { stripSyntheticGaps } from '@uomi/audio'
import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  getProvider,
  type transcribe,
  type Provider,
  type Transcription,
} from '@nakasyou/ntranscribe'
import { ReservationCoordinator } from './coordinator'
import {
  NotionStore,
  validateManifest,
  type AudioManifest,
  transcriptionFields,
  type TranscriptionMode,
} from '@uomi/notion'

export interface Config {
  secret: string
  provider: Provider
  language: string
  stateDir: string
  requestWaitMs: number
  timeoutMs: number
  sitesCallback?: SitesCallback
  splitSeconds?: number
}
export function authorized(header: string | null, secret: string): boolean {
  const a = Buffer.from(header ?? '')
  const b = Buffer.from(`Bearer ${secret}`)
  return a.length === b.length && timingSafeEqual(a, b)
}
export function pageId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i.test(value)
  )
    throw Error('Invalid pageId.')
  return value.replace(/-/g, '').toLowerCase()
}
export class Daemon {
  private jobs = new Map<string, { id: string; mode: TranscriptionMode }>()
  private running = false
  private closing = false
  private drainPromise: Promise<void> = Promise.resolve()
  private nextRequest = 0
  private coordinator?: ReservationCoordinator
  private recovering = false
  private readonly queueLimit = 32
  private callbacks: CompletionOutbox
  constructor(
    readonly store: NotionStore,
    readonly config: Config,
    private recognize: typeof transcribe = (path, options = {}) =>
      getProvider(options.provider).transcribeFile(path, options),
  ) {
    this.callbacks = new CompletionOutbox(
      join(config.stateDir, 'completion-outbox'),
      config.sitesCallback,
      config.secret,
      async (id, mode) => {
        const page = await this.store.page(id)
        return (
          !page.archived &&
          !page.in_trash &&
          page.properties[transcriptionFields(mode).status]?.select?.name === 'Completed' &&
          (await this.store.owns(page))
        )
      },
    )
  }
  async reserve(value: unknown): Promise<{ pageId: string }> {
    if (this.closing) throw Error('Daemon is shutting down.')
    this.coordinator ??= new ReservationCoordinator(this.store, this.config.stateDir)
    return this.coordinator.reserve(value)
  }
  async accept(
    value: unknown,
    mode: TranscriptionMode = 'standard',
  ): Promise<{ accepted: boolean; completed?: boolean }> {
    if (this.closing) throw Error('Daemon is shutting down.')
    if (!['standard', 'detailed'].includes(mode)) throw Error('Invalid transcription mode.')
    const fields = transcriptionFields(mode)
    const id = pageId(value)
    const key = `${id}:${mode}`
    if (this.jobs.has(key)) return { accepted: false }
    if (this.jobs.size >= this.queueLimit)
      throw Error('Transcriber queue is full. Notion will be polled again.')
    const page = await this.store.page(id)
    if (!(await this.store.owns(page)))
      throw Error('Page does not belong to the configured Uomi database.')
    const status = page.properties[fields.status]?.select?.name
    if (page.archived || page.in_trash) throw Error('Page was removed.')
    if (status === 'Completed') {
      await this.callbacks.enqueue(id, mode)
      void this.callbacks
        .flush(1)
        .catch((error) =>
          console.error(JSON.stringify({ stage: 'callback_recovery', error: errorDetail(error) })),
        )
      return { accepted: false, completed: true }
    }
    if (page.properties.Status?.select?.name === 'Uploading')
      throw Error('Audio has not finished uploading.')
    if (mode === 'standard' && !['Pending', 'Failed', 'Processing'].includes(status))
      throw Error('Audio has not finished uploading.')
    // Validate attachments before acknowledging. Notion remains the durable job record.
    this.store.fileUrl(page, 'Audio')
    this.store.fileUrl(page, 'Manifest')
    if (this.jobs.has(key)) return { accepted: false }
    if (mode === 'detailed' && !['Pending', 'Processing'].includes(status))
      await this.store.update(id, {
        [fields.status]: { select: { name: 'Pending' } },
        [fields.error]: { rich_text: [] },
        [fields.attempts]: { number: 0 },
        [fields.retry]: { date: null },
      })
    if (this.jobs.has(key)) return { accepted: false }
    if (this.closing) throw Error('Daemon is shutting down.')
    if (this.jobs.size >= this.queueLimit)
      throw Error('Transcriber queue is full. Notion will be polled again.')
    this.jobs.set(key, { id, mode })
    if (!this.running) {
      this.running = true
      this.drainPromise = this.drain()
    }
    return { accepted: true }
  }
  async recover(): Promise<number> {
    if (this.closing || this.recovering || this.jobs.size >= this.queueLimit) return 0
    this.recovering = true
    let accepted = 0
    try {
      await this.callbacks.flush()
      // Explicit recording requests take priority over the automatic backlog.
      for (const mode of ['detailed', 'standard'] as const) {
        const fields = transcriptionFields(mode)
        const due = {
          // queryPages adds an outer AND for pagination windows. Keep this OR
          // flat to stay within Notion's two compound-filter nesting levels.
          // Failed-job retry dates are checked below before admission.
          or: ['Pending', 'Processing', 'Failed'].map((name) => ({
            property: fields.status,
            select: { equals: name },
          })),
        }
        for await (const pages of this.store.queryPages(due))
          for (const page of pages) {
            if (this.jobs.size >= this.queueLimit) return accepted
            const id = pageId(page.id)
            const key = `${id}:${mode}`
            if (
              this.jobs.has(key) ||
              page.archived ||
              page.in_trash ||
              page.properties.Status?.select?.name === 'Uploading' ||
              !page.properties.Audio?.files?.length ||
              !page.properties.Manifest?.files?.length
            )
              continue
            const status = page.properties[fields.status]?.select?.name
            if (!['Pending', 'Processing', 'Failed'].includes(status)) continue
            if (status === 'Failed') {
              const retry = Date.parse(page.properties[fields.retry]?.date?.start ?? '')
              if (Number.isFinite(retry) && retry > Date.now()) continue
            }
            this.jobs.set(key, { id, mode })
            accepted++
            if (!this.running) {
              this.running = true
              this.drainPromise = this.drain()
            }
          }
      }
      return accepted
    } finally {
      this.recovering = false
    }
  }
  async close(): Promise<void> {
    this.closing = true
    await this.coordinator?.close()
    await this.drainPromise
    await this.callbacks.flush()
  }
  private async attachment(page: any, property: string): Promise<Uint8Array> {
    const url = this.store.fileUrl(page, property)
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120000) })
    if (!response.ok)
      throw Error(
        `Notion attachment download HTTP ${response.status}: ${(await response.text()).slice(0, 1500)}`,
      )
    const max = 64 * 1024 * 1024
    if (Number(response.headers.get('content-length')) > max) {
      await response.body?.cancel()
      throw Error('Attachment exceeds the 64 MiB processing limit.')
    }
    const reader = response.body!.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const part = await reader.read()
      if (part.done) break
      total += part.value.length
      if (total > max) {
        await reader.cancel()
        throw Error('Attachment exceeds the 64 MiB processing limit.')
      }
      chunks.push(part.value)
    }
    return Buffer.concat(chunks)
  }
  private async drain() {
    try {
      for (const [key, { id, mode }] of this.jobs) {
        const fields = transcriptionFields(mode)
        try {
          await this.process(id, mode)
          await this.callbacks
            .flush(1)
            .catch((error) =>
              console.error(
                JSON.stringify({ stage: 'callback_outbox', error: errorDetail(error) }),
              ),
            )
          console.log(JSON.stringify({ pageId: id, mode, status: 'Completed' }))
        } catch (error) {
          const detail = (
            error instanceof Error ? `${error.name}: ${error.message}` : String(error)
          ).slice(0, 1800)
          try {
            const page = await this.store.page(id)
            const attempts = (page.properties[fields.attempts]?.number ?? 0) + 1
            const retry =
              Date.now() + Math.min(6 * 3600000, 300000 * 2 ** Math.min(attempts - 1, 7))
            await this.store.update(id, {
              [fields.status]: { select: { name: 'Failed' } },
              [fields.attempts]: { number: attempts },
              [fields.retry]: { date: { start: new Date(retry).toISOString() } },
              [fields.error]: {
                rich_text: [
                  {
                    type: 'text',
                    text: {
                      content: detail,
                    },
                  },
                ],
              },
            })
          } catch (updateError) {
            console.error(
              JSON.stringify({
                pageId: id,
                mode,
                status: 'Failed',
                error: errorDetail(updateError),
                original: detail,
              }),
            )
          }
          console.error(JSON.stringify({ pageId: id, mode, status: 'Failed', error: detail }))
        } finally {
          this.jobs.delete(key)
        }
      }
    } finally {
      this.running = false
    }
  }
  private async process(id: string, mode: TranscriptionMode = 'standard') {
    const fields = transcriptionFields(mode)
    const provider = mode === 'detailed' ? 'codex' : this.config.provider
    const page = await this.store.page(id)
    if (page.properties[fields.status]?.select?.name === 'Completed') return
    if (page.archived || page.in_trash) throw Error('Page was removed.')
    if (!(await this.store.owns(page))) throw Error('Wrong Notion database.')
    // Persist before Completed, so a crash cannot lose either result notification.
    await this.callbacks.enqueue(pageId(id), mode)
    await this.store.update(id, {
      [fields.status]: { select: { name: 'Processing' } },
      [fields.error]: { rich_text: [] },
    })
    const manifest: AudioManifest = JSON.parse(
      Buffer.from(await this.attachment(page, 'Manifest')).toString(),
    )
    validateManifest(manifest)
    const audio = await this.attachment(page, 'Audio')
    if (createHash('sha256').update(audio).digest('hex') !== manifest.sha256)
      throw Error('Audio checksum mismatch.')
    // Earlier direct clients could create duplicate pages. Only archive an
    // untranscribed duplicate after the canonical page's identical audio has
    // been verified and its transcription has completed.
    const duplicates = await this.store.query({
      property: 'Recording ID',
      rich_text: { equals: manifest.id },
    })
    const canonical = duplicates
      .filter(
        (candidate) =>
          candidate.properties.Audio?.files?.length && candidate.properties.Manifest?.files?.length,
      )
      .sort(
        (a, b) =>
          (a.created_time ?? '').localeCompare(b.created_time ?? '') || a.id.localeCompare(b.id),
      )[0]
    if (
      mode === 'standard' &&
      !page.properties['Detailed status']?.select?.name &&
      canonical &&
      pageId(canonical.id) !== pageId(page.id)
    ) {
      const saved: AudioManifest = JSON.parse(
        Buffer.from(await this.attachment(canonical, 'Manifest')).toString(),
      )
      const canonicalAudio = await this.attachment(canonical, 'Audio')
      if (
        saved.sha256 !== manifest.sha256 ||
        createHash('sha256').update(canonicalAudio).digest('hex') !== manifest.sha256 ||
        JSON.stringify(saved.frameIds) !== JSON.stringify(manifest.frameIds)
      )
        throw Error('Duplicate recording IDs have conflicting audio; review them before retrying.')
      if (canonical.properties.Status?.select?.name !== 'Completed')
        await this.process(canonical.id)
      if ((await this.store.page(canonical.id)).properties.Status?.select?.name !== 'Completed')
        throw Error('Canonical transcription is not complete.')
      await this.callbacks.enqueue(pageId(canonical.id))
      await this.callbacks.discard(pageId(page.id))
      await this.store.archive(page.id)
      return
    }
    await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 })
    const checkpoint = join(
      this.config.stateDir,
      `${id}${mode === 'detailed' ? '.detailed' : ''}.json`,
    )
    let previous: {
      splitSeconds?: number
      inputTransform?: string
      audioHash: string
      provider: string
      language: string
      chunks: Transcription[]
    } = {
      splitSeconds: this.config.splitSeconds ?? 600,
      inputTransform: manifest.gaps?.length ? 'synthetic-gaps-removed-v1' : 'original-v1',
      audioHash: manifest.sha256,
      provider,
      language: this.config.language,
      chunks: [],
    }
    try {
      const saved = JSON.parse(await readFile(checkpoint, 'utf8'))
      if (
        (saved.inputTransform === previous.inputTransform ||
          (!saved.inputTransform && !manifest.gaps?.length)) &&
        saved.audioHash === manifest.sha256 &&
        saved.provider === provider &&
        saved.language === this.config.language &&
        (saved.splitSeconds ?? 600) === previous.splitSeconds
      )
        previous = saved
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw Error(`Cannot read legacy checkpoint ${checkpoint}: ${errorDetail(error)}`, {
          cause: error,
        })
    }
    const directory = await mkdtemp(join(tmpdir(), 'uomi-transcriber-'))
    try {
      const path = join(directory, 'audio.ogg')
      await writeFile(path, stripSyntheticGaps(audio, manifest.gaps, manifest.frameIds.length), {
        mode: 0o600,
      })
      // Split on this side to make each request checkpointable and paced, including Codex.
      const split = Bun.spawn(
        [
          'ffmpeg',
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-i',
          path,
          '-map',
          '0:a:0',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'flac',
          '-f',
          'segment',
          '-segment_time',
          String(this.config.splitSeconds ?? 600),
          '-reset_timestamps',
          '1',
          join(directory, 'chunk-%06d.flac'),
        ],
        { stdout: 'ignore', stderr: 'pipe' },
      )
      const diagnostics = await new Response(split.stderr).text()
      const exitCode = await split.exited
      if (exitCode !== 0) throw Error(`ffmpeg exited ${exitCode}: ${diagnostics.slice(-2000)}`)
      const files = await nonEmptyAudioSegments(directory, new AbortController().signal)
      if (previous.chunks.length > files.length)
        throw Error('Audio split does not match transcription checkpoint.')
      for (let i = previous.chunks.length; i < files.length; i++) {
        const wait = this.nextRequest - Date.now()
        if (wait > 0) await Bun.sleep(wait)
        try {
          // Disable the provider's separate default boundary by using our checkpointed split.
          const result = await this.recognize(join(directory, files[i]), {
            provider,
            language: this.config.language,
            timeoutMs: this.config.timeoutMs,
            splitSeconds: this.config.splitSeconds ?? 600,
          })
          previous.chunks.push(result)
          const temp = checkpoint + '.tmp'
          await writeFile(temp, JSON.stringify(previous), { mode: 0o600 })
          await import('node:fs/promises').then((fs) => fs.rename(temp, checkpoint))
        } catch (error) {
          const failure = error as { status?: number; retryAfter?: string | null }
          if (failure.status === 429 || /HTTP 429/.test(String(error))) {
            const seconds = Number(failure.retryAfter)
            const date = failure.retryAfter ? Date.parse(failure.retryAfter) : NaN
            this.nextRequest =
              Date.now() +
              Math.max(
                60000,
                Number.isFinite(seconds)
                  ? seconds * 1000
                  : Number.isFinite(date)
                    ? date - Date.now()
                    : 30 * 60000,
              )
          } else if (failure.status && failure.status >= 500) this.nextRequest = Date.now() + 60000
          throw error
        } finally {
          this.nextRequest = Math.max(this.nextRequest, Date.now() + this.config.requestWaitMs)
        }
      }
      await this.store.saveTranscript(
        id,
        previous.chunks
          .map((chunk) => chunk.text.trim())
          .filter(Boolean)
          .join('\n'),
        provider,
        mode,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}
