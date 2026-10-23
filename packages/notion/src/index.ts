import { Buffer } from 'buffer'

export const NOTION_VERSION = '2025-09-03'
export type ProcessingStatus = 'Uploading' | 'Pending' | 'Processing' | 'Completed' | 'Failed'
export interface UploadBody {
  filename: string
  contentType: string
  base64: string
  part?: number
}
export interface NotionRequest {
  path: string
  method: 'GET' | 'POST' | 'PATCH'
  body?: unknown
  upload?: UploadBody
}
export type Transport = (request: NotionRequest) => Promise<any>
export interface RemoteRecording {
  id: string
  pageId: string
  url: string
  deviceId: string
  capturedAt: string | null
  durationMs: number
  firstFrameId: string
  lastFrameId: string
  frameCount: number
  status: ProcessingStatus
  transcript: string
  error: string
  target: string
  notificationError?: string
}
export interface AudioManifest {
  schema: 'uomi.notion.v1'
  id: string
  deviceId: string
  capturedAt: string | null
  durationMs: number
  sha256: string
  frameIds: string[]
  gaps?: { beforeFrame: number; durationMs: number; offsetMs?: number }[]
  // Per-packet metadata preserves the device clock independently from audio playback time.
  timing: {
    sequence: string
    ringId: string | null
    timestamp: number
    capturedAt: string | null
    firstFrame: number
    frames: number
  }[]
}
export function validateManifest(value: unknown): asserts value is AudioManifest {
  const manifest = value as AudioManifest
  if (
    !manifest ||
    manifest.schema !== 'uomi.notion.v1' ||
    typeof manifest.id !== 'string' ||
    !manifest.id ||
    !Number.isFinite(manifest.durationMs) ||
    manifest.durationMs <= 0 ||
    manifest.durationMs > 900000 ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? '') ||
    !Array.isArray(manifest.frameIds) ||
    !manifest.frameIds.length ||
    manifest.frameIds.length > 360000 ||
    manifest.frameIds.some((id) => typeof id !== 'string' || id.length > 512) ||
    new Set(manifest.frameIds).size !== manifest.frameIds.length
  )
    throw Error('Invalid audio manifest. Original audio is retained.')
  if (!Array.isArray(manifest.timing) || manifest.timing.length > manifest.frameIds.length)
    throw Error('Invalid source timing metadata.')
  let end = 0
  for (const timing of manifest.timing) {
    if (
      !Number.isInteger(timing.firstFrame) ||
      !Number.isInteger(timing.frames) ||
      timing.firstFrame !== end ||
      timing.frames <= 0 ||
      timing.firstFrame + timing.frames > manifest.frameIds.length ||
      !Number.isFinite(timing.timestamp)
    )
      throw Error('Invalid source timing metadata.')
    end = timing.firstFrame + timing.frames
  }
  if (manifest.timing.length && end !== manifest.frameIds.length)
    throw Error('Incomplete source timing metadata.')
  let previous = -1,
    total = 0
  if (manifest.gaps !== undefined && manifest.gaps !== null) {
    if (!Array.isArray(manifest.gaps) || manifest.gaps.length > manifest.frameIds.length)
      throw Error('Invalid audio gap metadata.')
    for (const gap of manifest.gaps) {
      if (
        !Number.isInteger(gap.beforeFrame) ||
        gap.beforeFrame <= previous ||
        gap.beforeFrame >= manifest.frameIds.length ||
        !Number.isFinite(gap.durationMs) ||
        gap.durationMs <= 0 ||
        (gap.durationMs * 2) % 5 !== 0
      )
        throw Error('Invalid audio gap metadata.')
      if (
        gap.offsetMs !== undefined &&
        (!Number.isFinite(gap.offsetMs) ||
          gap.offsetMs < 0 ||
          gap.offsetMs + gap.durationMs > manifest.durationMs)
      )
        throw Error('Invalid synthetic gap offset.')
      previous = gap.beforeFrame
      total += gap.durationMs
    }
    if (total >= manifest.durationMs) throw Error('Audio gap metadata exceeds its duration.')
  }
}
export function notionId(value: string): string {
  const candidate = value
    .trim()
    .match(
      /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i,
    )?.[1]
  if (!candidate) throw Error('Enter a Notion database/data source ID or its page URL.')
  return candidate.replace(/-/g, '').toLowerCase()
}
const rich = (text: string) =>
  Array.from({ length: Math.ceil(text.length / 1800) }, (_, i) => ({
    type: 'text',
    text: { content: text.slice(i * 1800, (i + 1) * 1800) },
  }))
const plain = (values: any[] = []) =>
  values.map((v) => v.plain_text ?? v.text?.content ?? '').join('')
export function silenceProperties(manifest: AudioManifest): Record<string, unknown> {
  const gaps = manifest.gaps ?? []
  const start = manifest.capturedAt ? Date.parse(manifest.capturedAt) : NaN
  const intervals: Record<string, unknown>[] = []
  let size = 0
  for (const gap of gaps) {
    const offset = gap.offsetMs
    const absolute = offset !== undefined && Number.isFinite(start) ? start + offset : undefined
    const interval = {
      before_frame: gap.beforeFrame,
      duration_ms: gap.durationMs,
      ...(offset !== undefined
        ? { offset_ms: offset, end_offset_ms: offset + gap.durationMs }
        : {}),
      ...(absolute !== undefined
        ? {
            started_at_ms: absolute,
            finished_at_ms: absolute + gap.durationMs,
            started_at: new Date(absolute).toISOString(),
            finished_at: new Date(absolute + gap.durationMs).toISOString(),
          }
        : {}),
    }
    const length = JSON.stringify(interval).length + 1
    if (size + length > 5500) break
    intervals.push(interval)
    size += length
  }
  return {
    'Synthetic silence (s)': { number: gaps.reduce((n, gap) => n + gap.durationMs, 0) / 1000 },
    'Synthetic silence count': { number: gaps.length },
    'Synthetic silence intervals': {
      rich_text: rich(
        gaps.length
          ? JSON.stringify({
              intervals,
              total_count: gaps.length,
              complete: intervals.length === gaps.length,
              full_data: 'Manifest.gaps',
            })
          : '',
      ),
    },
  }
}
export const schema = {
  Name: { title: {} },
  Starred: { checkbox: {} },
  'Recording ID': { rich_text: {} },
  Device: { rich_text: {} },
  'Recorded at': { date: {} },
  record_finished_at: { date: {} },
  recorded_at_ms: { number: {} },
  record_finished_at_ms: { number: {} },
  'Duration (s)': { number: {} },
  Status: {
    select: {
      options: ['Uploading', 'Pending', 'Processing', 'Completed', 'Failed'].map((name) => ({
        name,
      })),
    },
  },
  Audio: { files: {} },
  Manifest: { files: {} },
  Transcript: { files: {} },
  'Transcript preview': { rich_text: {} },
  Error: { rich_text: {} },
  'Synthetic silence (s)': { number: {} },
  'Synthetic silence count': { number: {} },
  'Synthetic silence intervals': { rich_text: {} },
  Attempts: { number: {} },
  'Retry after': { date: {} },
}
export class NotionStore {
  private sourceMetadata?: any
  private limitRequest?: Promise<number>
  private readyId?: string
  private setupComplete = false
  private uploadLimit?: number
  constructor(
    readonly transport: Transport,
    readonly database: string,
  ) {}
  async source(): Promise<string> {
    if (this.readyId) return this.readyId
    const id = notionId(this.database)
    // Accept either a data source ID or a database URL. Only retry the alternate kind on 404.
    try {
      this.sourceMetadata = await this.transport({ path: `/data_sources/${id}`, method: 'GET' })
      this.readyId = id
    } catch (e) {
      if (!String(e).includes('404')) throw e
      const db = await this.transport({ path: `/databases/${id}`, method: 'GET' })
      if (db.data_sources?.length !== 1)
        throw Error('Choose the data source ID when a database has multiple data sources.')
      this.readyId = db.data_sources[0].id
    }
    return this.readyId!
  }
  async setup(): Promise<void> {
    if (this.setupComplete) return
    const id = await this.source()
    const existing =
      this.sourceMetadata ?? (await this.transport({ path: `/data_sources/${id}`, method: 'GET' }))
    this.sourceMetadata = undefined
    const properties: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(schema)) {
      const type = Object.keys(value)[0]
      if (existing.properties?.[key] && existing.properties[key].type !== type)
        throw Error(
          `Notion property "${key}" must have type ${type}. Use a dedicated Uomi database.`,
        )
      if (!existing.properties?.[key]) properties[key] = value
    }
    // Respect the database's existing title property rather than adding a second title column.
    const title = Object.entries<any>(existing.properties ?? {}).find(
      ([, value]) => value.type === 'title',
    )?.[0]
    if (title && title !== 'Name') {
      delete properties.Name
      properties[title] = { name: 'Name' }
    }
    if (Object.keys(properties).length)
      await this.transport({ path: `/data_sources/${id}`, method: 'PATCH', body: { properties } })
    this.setupComplete = true
  }
  async *queryPages(filter?: unknown, archived = false): AsyncGenerator<any[]> {
    // A capped query reports has_more=false. Split its creation-time domain;
    // never mistake that response for a complete result.
    const transport = this.transport
    const source = await this.source()
    async function* window(lower: number, upper: number): AsyncGenerator<any[]> {
      let cursor: string | undefined
      do {
        const range = {
          and: [
            ...(filter ? [filter] : []),
            {
              timestamp: 'created_time',
              created_time: { on_or_after: new Date(lower).toISOString() },
            },
            { timestamp: 'created_time', created_time: { before: new Date(upper).toISOString() } },
          ],
        }
        const result = await transport({
          path: `/data_sources/${source}/query`,
          method: 'POST',
          body: {
            page_size: 100,
            ...(archived ? { is_archived: true } : {}),
            filter: range,
            sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
            ...(cursor ? { start_cursor: cursor } : {}),
          },
        })
        if (result.request_status?.type === 'incomplete') {
          if (cursor || upper - lower <= 1)
            throw Error(
              'Notion query was truncated. Narrow the database or creation-time range before continuing.',
            )
          const middle = Math.floor(lower + (upper - lower) / 2)
          yield* window(lower, middle)
          yield* window(middle, upper)
          return
        }
        yield result.results ?? []
        cursor = result.has_more ? result.next_cursor : undefined
        if (result.has_more && !cursor) throw Error('Notion pagination returned no cursor.')
      } while (cursor)
    }
    yield* window(0, Date.now() + 86400000)
  }
  async query(
    filter?: unknown,
    onPage?: (loaded: number, hasMore: boolean) => void,
  ): Promise<any[]> {
    const pages: any[] = []
    for await (const batch of this.queryPages(filter)) {
      pages.push(...batch)
      onPage?.(pages.length, true)
    }
    onPage?.(pages.length, false)
    return pages
  }
  async ensureRecordingEnd(page: any): Promise<void> {
    const properties: Record<string, unknown> = {}
    const start = Date.parse(page.properties['Recorded at']?.date?.start ?? '')
    const seconds = page.properties['Duration (s)']?.number
    const existingEnd = Date.parse(page.properties.record_finished_at?.date?.start ?? '')
    const end = Number.isFinite(existingEnd)
      ? existingEnd
      : Number.isFinite(start) &&
          typeof seconds === 'number' &&
          Number.isFinite(seconds) &&
          seconds >= 0
        ? Math.round(start + seconds * 1000)
        : NaN
    if (Number.isFinite(start) && page.properties.recorded_at_ms?.number == null)
      properties.recorded_at_ms = { number: start }
    if (Number.isFinite(end)) {
      if (!page.properties.record_finished_at?.date)
        properties.record_finished_at = { date: { start: new Date(end).toISOString() } }
      if (page.properties.record_finished_at_ms?.number == null)
        properties.record_finished_at_ms = { number: end }
    }
    if (Object.keys(properties).length) await this.update(page.id, properties)
  }

  async find(id: string): Promise<any | undefined> {
    return (await this.query({ property: 'Recording ID', rich_text: { equals: id } })).sort(
      (a, b) =>
        (a.created_time ?? '').localeCompare(b.created_time ?? '') || a.id.localeCompare(b.id),
    )[0]
  }
  async page(id: string): Promise<any> {
    if (!/^[a-f0-9-]{32,36}$/i.test(id)) throw Error('Invalid page ID.')
    return this.transport({ path: `/pages/${id}`, method: 'GET' })
  }
  async owns(page: any): Promise<boolean> {
    return (
      (page.parent?.data_source_id ?? '').replace(/-/g, '') ===
      (await this.source()).replace(/-/g, '')
    )
  }
  async archive(id: string): Promise<void> {
    await this.transport({ path: `/pages/${id}`, method: 'PATCH', body: { archived: true } })
  }
  async update(id: string, properties: Record<string, unknown>): Promise<any> {
    return this.transport({ path: `/pages/${id}`, method: 'PATCH', body: { properties } })
  }
  async status(id: string, status: ProcessingStatus, error = ''): Promise<void> {
    await this.update(id, {
      Status: { select: { name: status } },
      Error: { rich_text: rich(error.slice(0, 1500)) },
    })
  }
  async upload(filename: string, contentType: string, bytes: Uint8Array): Promise<string> {
    if (this.uploadLimit === undefined) {
      this.limitRequest ??= this.transport({ path: '/users/me', method: 'GET' })
        .then(
          (limits) =>
            limits.bot?.workspace_limits?.max_file_upload_size_in_bytes ?? 5 * 1024 * 1024,
        )
        .catch((error) => {
          this.limitRequest = undefined
          throw error
        })
      this.uploadLimit = await this.limitRequest
    }
    const max = this.uploadLimit!
    if (bytes.length > max)
      throw Error(
        'This file exceeds your Notion workspace upload limit. Choose shorter audio chunks.',
      )
    const multipart = bytes.length > 20 * 1024 * 1024
    const partSize = 5 * 1024 * 1024
    const file = await this.transport({
      path: '/file_uploads',
      method: 'POST',
      body: {
        mode: multipart ? 'multi_part' : 'single_part',
        filename,
        content_type: contentType,
        ...(multipart ? { number_of_parts: Math.ceil(bytes.length / partSize) } : {}),
      },
    })
    const count = multipart ? Math.ceil(bytes.length / partSize) : 1
    for (let i = 0; i < count; i++) {
      const part = multipart ? bytes.subarray(i * partSize, (i + 1) * partSize) : bytes
      await this.transport({
        path: `/file_uploads/${file.id}/send`,
        method: 'POST',
        upload: {
          filename,
          contentType,
          base64: Buffer.from(part).toString('base64'),
          ...(multipart ? { part: i + 1 } : {}),
        },
      })
    }
    if (multipart)
      await this.transport({ path: `/file_uploads/${file.id}/complete`, method: 'POST', body: {} })
    return file.id
  }
  async reserve(manifest: AudioManifest): Promise<any> {
    const existing = await this.find(manifest.id)
    if (existing) return existing
    return this.createReservedPage(manifest)
  }
  // Caller must have reconciled Recording ID and durably journaled its create intent.
  async createReservedPage(manifest: AudioManifest): Promise<any> {
    return this.transport({
      path: '/pages',
      method: 'POST',
      body: {
        parent: { type: 'data_source_id', data_source_id: await this.source() },
        properties: {
          Name: { title: rich(manifest.capturedAt ?? 'Recording · device clock unset') },
          'Recording ID': { rich_text: rich(manifest.id) },
          Device: { rich_text: rich(manifest.deviceId) },
          'Recorded at': { date: manifest.capturedAt ? { start: manifest.capturedAt } : null },
          record_finished_at: {
            date: manifest.capturedAt
              ? {
                  start: new Date(
                    Date.parse(manifest.capturedAt) + manifest.durationMs,
                  ).toISOString(),
                }
              : null,
          },
          recorded_at_ms: { number: manifest.capturedAt ? Date.parse(manifest.capturedAt) : null },
          record_finished_at_ms: {
            number: manifest.capturedAt
              ? Math.round(Date.parse(manifest.capturedAt) + manifest.durationMs)
              : null,
          },
          ...silenceProperties(manifest),
          'Duration (s)': { number: manifest.durationMs / 1000 },
          Status: { select: { name: 'Uploading' } },
        },
      },
    })
  }
  async ensureSilence(page: any, manifest: AudioManifest): Promise<void> {
    const values = silenceProperties(manifest)
    const expected = (values['Synthetic silence intervals'] as any).rich_text
    if (
      page.properties['Synthetic silence (s)']?.number ===
        (values['Synthetic silence (s)'] as any).number &&
      page.properties['Synthetic silence count']?.number ===
        (values['Synthetic silence count'] as any).number &&
      plain(page.properties['Synthetic silence intervals']?.rich_text) === plain(expected)
    )
      return
    const updated = await this.update(page.id, values)
    Object.assign(page, updated)
  }
  async reusableUpload(id?: string): Promise<boolean> {
    if (!id) return false
    try {
      const upload = await this.transport({ path: `/file_uploads/${id}`, method: 'GET' })
      return (
        upload.status === 'uploaded' &&
        (!upload.expiry_time || Date.parse(upload.expiry_time) > Date.now() + 60000)
      )
    } catch (error) {
      if (/HTTP (400|404)/.test(String(error))) return false
      throw error
    }
  }
  async attachAudio(
    manifest: AudioManifest,
    page: any,
    audioId?: string,
    manifestId?: string,
  ): Promise<any> {
    const file = (id: string, name: string) => ({ name, type: 'file_upload', file_upload: { id } })
    const properties: Record<string, unknown> = { ...silenceProperties(manifest) }
    const attaching =
      !page.properties.Audio?.files?.length || !page.properties.Manifest?.files?.length
    if (!page.properties.Audio?.files?.length) {
      if (!audioId) throw Error('Audio upload is incomplete. Local audio is retained.')
      properties.Audio = { files: [file(audioId, `${manifest.id}.ogg`)] }
    }
    if (!page.properties.Manifest?.files?.length) {
      if (!manifestId) throw Error('Audio metadata upload is incomplete. Local audio is retained.')
      properties.Manifest = { files: [file(manifestId, `${manifest.id}.json`)] }
    }
    if (attaching || page.properties.Status?.select?.name === 'Uploading')
      properties.Status = { select: { name: 'Pending' } }
    return Object.keys(properties).length ? this.update(page.id, properties) : page
  }
  async saveAudio(
    manifest: AudioManifest,
    audio: Uint8Array,
    reserved?: any,
    onStep?: (detail: string) => void,
  ): Promise<any> {
    const page = reserved ?? (await this.reserve(manifest))
    let audioId: string | undefined
    let manifestId: string | undefined
    if (!page.properties.Audio?.files?.length) {
      onStep?.('Uploading audio')
      audioId = await this.upload(`${manifest.id}.ogg`, 'audio/ogg', audio)
    }
    if (!page.properties.Manifest?.files?.length) {
      onStep?.('Uploading audio metadata')
      manifestId = await this.upload(
        `${manifest.id}.json`,
        'application/json',
        Buffer.from(JSON.stringify(manifest)),
      )
    }
    onStep?.('Attaching files to Notion')
    return this.attachAudio(manifest, page, audioId, manifestId)
  }
  fileUrl(page: any, property: string): string {
    const file = page.properties[property]?.files?.[0]
    const url = file?.file?.url
    if (!url || !url.startsWith('https://'))
      throw Error(`Notion page is missing its ${property} attachment.`)
    return url
  }
  remotePage(page: any, target: string, cached?: RemoteRecording): RemoteRecording {
    const properties = page.properties
    return {
      ...cached,
      id: plain(properties['Recording ID']?.rich_text) || page.id,
      pageId: page.id,
      url: page.url ?? `https://www.notion.so/${page.id.replace(/-/g, '')}`,
      deviceId: plain(properties.Device?.rich_text),
      capturedAt: properties['Recorded at']?.date?.start ?? null,
      durationMs: (properties['Duration (s)']?.number ?? 0) * 1000,
      firstFrameId: cached?.firstFrameId ?? '',
      lastFrameId: cached?.lastFrameId ?? '',
      frameCount: cached?.frameCount ?? 0,
      status: properties.Status?.select?.name ?? 'Pending',
      notificationError: ['Uploading', 'Pending', 'Failed'].includes(
        properties.Status?.select?.name ?? 'Pending',
      )
        ? cached?.notificationError
        : undefined,
      transcript: plain(properties['Transcript preview']?.rich_text),
      error: plain(properties.Error?.rich_text),
      target,
    }
  }
  remote(page: any, manifest: AudioManifest, target: string): RemoteRecording {
    return {
      id: manifest.id,
      pageId: page.id,
      url: page.url,
      deviceId: manifest.deviceId,
      capturedAt: manifest.capturedAt,
      durationMs: manifest.durationMs,
      firstFrameId: manifest.frameIds[0],
      lastFrameId: manifest.frameIds.at(-1)!,
      frameCount: manifest.frameIds.length,
      status: page.properties.Status?.select?.name ?? 'Pending',
      transcript: plain(page.properties['Transcript preview']?.rich_text),
      error: plain(page.properties.Error?.rich_text),
      target,
    }
  }
  async saveTranscript(pageId: string, text: string, provider: string): Promise<void> {
    const fileId = await this.upload(
      `${pageId}-transcript.json`,
      'application/json',
      Buffer.from(
        JSON.stringify({
          schema: 'uomi.transcript.v1',
          text,
          provider,
          completedAt: new Date().toISOString(),
          wordTimestamps: false,
        }),
      ),
    )
    // Full text lives in a file; the bounded preview avoids Notion rich-text size limits.
    await this.update(pageId, {
      Transcript: {
        files: [{ name: 'transcript.json', type: 'file_upload', file_upload: { id: fileId } }],
      },
      'Transcript preview': { rich_text: rich(text.slice(0, 6000)) },
      Status: { select: { name: 'Completed' } },
      Error: { rich_text: [] },
    })
  }
}
export function httpTransport(token: string, fetcher: typeof fetch = fetch): Transport {
  return paceTransport(async (request) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
    }
    let body: BodyInit | undefined
    if (request.upload) {
      const form = new FormData()
      form.set(
        'file',
        new Blob([new Uint8Array(Buffer.from(request.upload.base64, 'base64'))], {
          type: request.upload.contentType,
        }),
        request.upload.filename,
      )
      if (request.upload.part) form.set('part_number', String(request.upload.part))
      body = form
    } else if (request.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(request.body)
    }
    const response = await fetcher(`https://api.notion.com/v1${request.path}`, {
      method: request.method,
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(120000),
    })
    if (!response.ok) {
      await response.body?.cancel()
      const retry = response.headers.get('retry-after')
      throw Error(
        `Notion HTTP ${response.status}${retry ? `; retry after ${retry}s` : ''}. Check connection permissions and try again.`,
      )
    }
    return response.json()
  })
}

// Pace request starts, not completions: slow uploads must not block independent
// stages. A shared gate still enforces request spacing and Retry-After globally.
export function paceTransport(transport: Transport, intervalMs = 400): Transport {
  let chain: Promise<unknown> = Promise.resolve()
  let next = 0
  const permit = () => {
    const gate = chain.then(async () => {
      while (next > Date.now())
        await new Promise((resolve) => setTimeout(resolve, next - Date.now()))
      next = Date.now() + intervalMs
    })
    chain = gate.catch(() => {})
    return gate
  }
  return async (request) => {
    for (let attempt = 0; ; attempt++) {
      await permit()
      try {
        return await transport(request)
      } catch (error) {
        const text = String(error)
        const seconds = text.match(/retry after (\d+)s/i)?.[1]
        if (seconds) next = Math.max(next, Date.now() + Number(seconds) * 1000)
        // Explicit 429 rejections did not create a page. Unknown POST outcomes
        // and 529 create failures are left to the durable reservation journal.
        const rejected = /HTTP 429/.test(text) && seconds
        const safeOverload =
          /HTTP 529/.test(text) && (request.method !== 'POST' || request.path.endsWith('/query'))
        if (attempt < 4 && (rejected || safeOverload)) {
          if (!seconds)
            next = Math.max(next, Date.now() + 1000 * 2 ** attempt + Math.random() * 250)
          continue
        }
        throw error
      }
    }
  }
}
