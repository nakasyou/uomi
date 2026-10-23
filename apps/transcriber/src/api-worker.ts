import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transcribe, type Provider, type Transcription } from '@nakasyou/ntranscribe'
import { validateManifest } from '@uomi/notion'

export interface Job {
  id: string
  recording_id: string
  mode: 'standard' | 'detailed'
  lease_token: string
  lease_until: number
  attempt: number
  audio_url: string
  manifest_url: string
  duration_ms: number
}
export interface WorkerConfig {
  url: string
  secret: string
  accessToken?: string
  workerId: string
  stateDir: string
  provider: Provider
  language: string
  concurrency: number
  splitSeconds: number
  requestWaitMs: number
  timeoutMs: number
  pollMs: number
}
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
export function errorDetail(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 4000)
}
/** Concurrent or abandoned leases must never share an intermediate checkpoint file. */
export async function saveCheckpoint(path: string, chunks: Transcription[], signal: AbortSignal) {
  signal.throwIfAborted()
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(chunks), { mode: 0o600 })
    signal.throwIfAborted()
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch((error) => {
      console.error(JSON.stringify({ stage: 'checkpoint_cleanup', error: errorDetail(error) }))
    })
  }
}
/** Durable ownership lives in the web database; local checkpoints only avoid repeated provider work. */
export class ApiWorker {
  private active = new Set<Promise<void>>()
  private stopped = false
  private polling = false
  private nextRequest = 0
  private pacing = Promise.resolve()
  lastError: string | null = null
  lastPollAt: string | null = null
  constructor(
    readonly config: WorkerConfig,
    private recognize = transcribe,
    private http: typeof fetch = fetch,
  ) {
    const url = new URL(config.url)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw Error('Invalid UOMI_API_URL.')
    if (!Number.isInteger(config.concurrency) || config.concurrency < 1 || config.concurrency > 8)
      throw Error('TRANSCRIBER_CONCURRENCY must be 1–8.')
  }
  get status() {
    return {
      active: this.active.size,
      concurrency: this.config.concurrency,
      lastPollAt: this.lastPollAt,
      error: this.lastError,
    }
  }
  private async request(path: string, body: unknown, signal?: AbortSignal): Promise<any> {
    const response = await this.http(new URL(path, this.config.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Uomi-Secret': this.config.secret,
        ...(this.config.accessToken
          ? { 'OAI-Sites-Authorization': `Bearer ${this.config.accessToken}` }
          : {}),
      },
      body: JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
      redirect: 'error',
    })
    const text = await response.text()
    if (!response.ok)
      throw new ApiError(
        response.status,
        `${path}: HTTP ${response.status}: ${text.slice(0, 2000)}`,
      )
    try {
      return JSON.parse(text)
    } catch (error) {
      throw Error(`${path}: server returned invalid JSON: ${text.slice(0, 500)}`, { cause: error })
    }
  }
  async poll(): Promise<number> {
    if (this.stopped || this.polling || this.active.size >= this.config.concurrency) return 0
    this.polling = true
    try {
      const { jobs } = await this.request('/api/jobs/claim', {
        worker_id: this.config.workerId,
        limit: this.config.concurrency - this.active.size,
        lease_seconds: 180,
      })
      if (!Array.isArray(jobs)) throw Error('Claim response is missing jobs array.')
      this.lastPollAt = new Date().toISOString()
      this.lastError = null
      for (const job of jobs as Job[]) {
        const task = this.run(job).finally(() => this.active.delete(task))
        this.active.add(task)
      }
      return jobs.length
    } catch (error) {
      this.lastError = errorDetail(error)
      throw error
    } finally {
      this.polling = false
    }
  }
  async close() {
    this.stopped = true
    await Promise.allSettled(this.active)
  }
  private async download(path: string, signal: AbortSignal, maxBytes: number): Promise<Uint8Array> {
    const url = new URL(path, this.config.url)
    if (url.origin !== new URL(this.config.url).origin)
      throw Error('Job attachment URL must use the API origin.')
    const response = await this.http(url, {
      headers: {
        'X-Uomi-Secret': this.config.secret,
        ...(this.config.accessToken
          ? { 'OAI-Sites-Authorization': `Bearer ${this.config.accessToken}` }
          : {}),
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
      redirect: 'error',
    })
    if (!response.ok)
      throw new ApiError(
        response.status,
        `Download ${url.pathname}: HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`,
      )
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel()
      throw Error('Attachment exceeds size limit.')
    }
    if (!response.body) throw Error('Attachment response has no body.')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > maxBytes) {
        await reader.cancel()
        throw Error('Attachment exceeds size limit.')
      }
      chunks.push(part.value)
    }
    return Buffer.concat(chunks)
  }
  private async pace(signal: AbortSignal) {
    const previous = this.pacing
    let release!: () => void
    this.pacing = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      await previous
      const wait = this.nextRequest - Date.now()
      if (wait > 0)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(done, wait)
          function done() {
            signal.removeEventListener('abort', abort)
            resolve()
          }
          function abort() {
            clearTimeout(timer)
            reject(signal.reason)
          }
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
        })
      signal.throwIfAborted()
      this.nextRequest = Date.now() + this.config.requestWaitMs
    } finally {
      release()
    }
  }
  private async run(job: Job) {
    const controller = new AbortController()
    let stage = 'downloading'
    let progress = 0
    let heartbeatBusy = false
    let heartbeatFailures = 0
    const beat = async () => {
      if (heartbeatBusy) return
      heartbeatBusy = true
      try {
        await this.request(
          `/api/jobs/${encodeURIComponent(job.id)}/heartbeat`,
          { lease_token: job.lease_token, stage, progress, lease_seconds: 180 },
          controller.signal,
        )
        heartbeatFailures = 0
      } catch (error) {
        console.error(
          JSON.stringify({ job: job.id, stage: 'heartbeat', error: errorDetail(error) }),
        )
        heartbeatFailures++
        if (
          (error instanceof ApiError && [401, 403, 409].includes(error.status)) ||
          heartbeatFailures >= 3
        )
          controller.abort(error)
      } finally {
        heartbeatBusy = false
      }
    }
    const timer = setInterval(() => {
      void beat()
    }, 30000)
    let directory: string | undefined
    try {
      await beat()
      controller.signal.throwIfAborted()
      const [manifestBytes, audio] = await Promise.all([
        this.download(job.manifest_url, controller.signal, 8 * 1024 * 1024),
        this.download(job.audio_url, controller.signal, 128 * 1024 * 1024),
      ])
      const manifest = JSON.parse(Buffer.from(manifestBytes).toString())
      validateManifest(manifest)
      // Migrated rows use their Notion page ID; manifest.id retains the original capture ID.
      // The API serves both assets for the claimed row, and SHA-256 binds their bytes below.
      if (createHash('sha256').update(audio).digest('hex') !== manifest.sha256)
        throw Error('Audio checksum mismatch.')
      const provider = job.mode === 'detailed' ? 'codex' : this.config.provider
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify([
            job.recording_id,
            job.mode,
            manifest.sha256,
            provider,
            this.config.language,
            this.config.splitSeconds,
          ]),
        )
        .digest('hex')
      await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 })
      const checkpoint = join(this.config.stateDir, `api-${fingerprint}.json`)
      let chunks: Transcription[] = []
      try {
        const saved = JSON.parse(await readFile(checkpoint, 'utf8'))
        if (!Array.isArray(saved) || saved.some((v: any) => typeof v.text !== 'string'))
          throw Error('Invalid checkpoint contents.')
        chunks = saved
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw Error(`Cannot read transcription checkpoint ${checkpoint}: ${errorDetail(error)}`)
      }
      directory = await mkdtemp(join(tmpdir(), 'uomi-api-'))
      const path = join(directory, 'audio.ogg')
      // Preserve recording time, including gaps, so future provider segment times use the same timeline as playback.
      await writeFile(path, audio, { mode: 0o600 })
      stage = 'decoding'
      await beat()
      controller.signal.throwIfAborted()
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
          String(this.config.splitSeconds),
          '-reset_timestamps',
          '1',
          join(directory, 'chunk-%06d.flac'),
        ],
        { stdout: 'ignore', stderr: 'pipe' },
      )
      let decodeTimedOut = false
      const decodeTimer = setTimeout(() => {
        decodeTimedOut = true
        split.kill()
      }, 120000)
      const kill = () => split.kill()
      controller.signal.addEventListener('abort', kill, { once: true })
      const stderr = await new Response(split.stderr).text()
      const code = await split.exited
      clearTimeout(decodeTimer)
      if (decodeTimedOut) throw Error('ffmpeg decoding exceeded 120 seconds.')
      controller.signal.removeEventListener('abort', kill)
      controller.signal.throwIfAborted()
      if (code !== 0) throw Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`)
      const files = (await readdir(directory))
        .filter((name) => /^chunk-\d+\.flac$/.test(name))
        .sort()
      if (!files.length || chunks.length > files.length)
        throw Error('Audio split does not match transcription checkpoint.')
      for (let i = chunks.length; i < files.length; i++) {
        stage = 'transcribing'
        progress = i / files.length
        await beat()
        controller.signal.throwIfAborted()
        await this.pace(controller.signal)
        const result = await this.recognize(join(directory, files[i]), {
          provider,
          language: this.config.language,
          timeoutMs: this.config.timeoutMs,
          splitSeconds: this.config.splitSeconds,
        })
        controller.signal.throwIfAborted()
        chunks.push(result)
        await saveCheckpoint(checkpoint, chunks, controller.signal)
      }
      stage = 'saving'
      progress = 1
      await beat()
      controller.signal.throwIfAborted()
      const segments = chunks.flatMap((chunk, index) =>
        Array.isArray(chunk.segments)
          ? chunk.segments.map((segment: any) => ({
              start_ms: index * this.config.splitSeconds * 1000 + segment.start_ms,
              end_ms: index * this.config.splitSeconds * 1000 + segment.end_ms,
              text: segment.text,
              speaker: segment.speaker ?? null,
            }))
          : [],
      )
      const result = {
        lease_token: job.lease_token,
        text: chunks
          .map((chunk) => chunk.text.trim())
          .filter(Boolean)
          .join('\n'),
        model: provider,
        segments,
      }
      // A lost completion response is safe to resend with the same fencing token.
      for (let attempt = 0; ; attempt++) {
        try {
          const receipt = await this.request(
            `/api/jobs/${encodeURIComponent(job.id)}/complete`,
            result,
            controller.signal,
          )
          if (receipt.saved !== true)
            throw Error('API did not acknowledge durable transcript storage.')
          break
        } catch (error) {
          if (
            controller.signal.aborted ||
            (error instanceof ApiError && error.status < 500) ||
            attempt >= 2
          )
            throw error
          await Bun.sleep(1000 * 2 ** attempt)
        }
      }
      await rm(checkpoint, { force: true })
      console.log(JSON.stringify({ job: job.id, recording: job.recording_id, status: 'completed' }))
    } catch (error) {
      const detail = errorDetail(error)
      this.lastError = detail
      console.error(
        JSON.stringify({ job: job.id, recording: job.recording_id, stage, error: detail }),
      )
      if (!(error instanceof ApiError && error.status === 409) && !controller.signal.aborted) {
        try {
          await this.request(`/api/jobs/${encodeURIComponent(job.id)}/fail`, {
            lease_token: job.lease_token,
            error: `${stage}: ${detail}`,
            retryable: !(error instanceof ApiError && [400, 404, 422].includes(error.status)),
            retry_after_seconds: /429/.test(detail) ? 1800 : 60,
          })
        } catch (failure) {
          console.error(
            JSON.stringify({
              job: job.id,
              stage: 'report_failure',
              error: errorDetail(failure),
              original: detail,
            }),
          )
        }
      }
    } finally {
      clearInterval(timer)
      controller.abort()
      if (directory)
        await rm(directory, { recursive: true, force: true }).catch((error) => {
          this.lastError = errorDetail(error)
          console.error(
            JSON.stringify({
              job: job.id,
              stage: 'temporary_audio_cleanup',
              error: this.lastError,
            }),
          )
        })
    }
  }
}
