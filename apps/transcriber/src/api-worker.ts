import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getProvider,
  type TranscribeOptions,
  type Provider,
  type Transcription,
} from '@nakasyou/ntranscribe'
import { validateManifest } from '@uomi/notion'
import { saveCheckpoint } from './checkpoint'
export { saveCheckpoint } from './checkpoint'
import { audioProcess, WorkSlots } from './process'
import { transcribeSpeech } from './speech-transcription'
import type { ProgressDetail } from './progress'

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
  codexSplitSeconds?: number
  fluidCommand?: string
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
/** Durable ownership lives in the web database; local checkpoints only avoid repeated provider work. */
export class ApiWorker {
  private active = new Set<Promise<void>>()
  private recognitionSlots = new WorkSlots(2)
  private analysisSlots = new WorkSlots(1)
  private stopped = false
  private polling = false
  private nextRequest = 0
  private pacing = Promise.resolve()
  lastError: string | null = null
  lastPollAt: string | null = null
  constructor(
    readonly config: WorkerConfig,
    private recognize: (path: string, options?: TranscribeOptions) => Promise<Transcription> = (
      path,
      options = {},
    ) => getProvider(options.provider).transcribeFile(path, options),
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
      splitSeconds: {
        google: this.config.splitSeconds,
        codex: this.config.codexSplitSeconds ?? 300,
      },
      speech: { engine: 'FluidAudio streaming', recognitionConcurrency: 2, analysisConcurrency: 1 },
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
  private async download(
    path: string,
    signal: AbortSignal,
    maxBytes: number,
    onProgress?: (received: number, total: number) => Promise<void>,
  ): Promise<Uint8Array> {
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
      await onProgress?.(size, Number(response.headers.get('content-length')) || 0)
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
    let detail: ProgressDetail = {}
    let heartbeatBusy = false
    let heartbeatFailures = 0
    let lastHeartbeat = 0
    const beat = async () => {
      if (heartbeatBusy) return
      heartbeatBusy = true
      lastHeartbeat = Date.now()
      try {
        await this.request(
          `/api/jobs/${encodeURIComponent(job.id)}/heartbeat`,
          { lease_token: job.lease_token, stage, progress, detail, lease_seconds: 180 },
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
        this.download(
          job.audio_url,
          controller.signal,
          128 * 1024 * 1024,
          async (bytes_received, bytes_total) => {
            detail = { bytes_received, bytes_total }
            if (Date.now() - lastHeartbeat >= 3000) await beat()
          },
        ),
      ])
      stage = 'verifying'
      detail = {}
      await beat()
      const manifest = JSON.parse(Buffer.from(manifestBytes).toString())
      validateManifest(manifest)
      // Migrated rows use their Notion page ID; manifest.id retains the original capture ID.
      // The API serves both assets for the claimed row, and SHA-256 binds their bytes below.
      if (createHash('sha256').update(audio).digest('hex') !== manifest.sha256)
        throw Error('Audio checksum mismatch.')
      const provider = job.mode === 'detailed' ? 'codex' : this.config.provider
      const splitSeconds =
        provider === 'codex' ? (this.config.codexSplitSeconds ?? 300) : this.config.splitSeconds
      await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 })
      directory = await mkdtemp(join(tmpdir(), 'uomi-api-'))
      const path = join(directory, 'audio.ogg')
      await writeFile(path, audio, { mode: 0o600 })
      let checkpoint: string
      let content: {
        text: string
        segments: unknown[]
        outcome?: 'no_speech' | 'empty' | 'transcribed'
      }
      if (provider !== 'codex') {
        const speech = await transcribeSpeech({
          audioPath: path,
          directory,
          stateDir: this.config.stateDir,
          helper: this.config.fluidCommand ?? 'uomi-fluid-segments',
          audioSha: manifest.sha256,
          recordingId: job.recording_id,
          mode: job.mode,
          language: this.config.language,
          durationMs: manifest.durationMs,
          splitSeconds,
          timeoutMs: this.config.timeoutMs,
          signal: controller.signal,
          analyze: (work) => this.analysisSlots.run(controller.signal, work),
          recognize: (audioPath, options, signal, onStart) =>
            this.recognitionSlots.run(signal, async () => {
              await onStart?.()
              return this.recognize(audioPath, { ...options, signal })
            }),
          stage: async (value, valueProgress, valueDetail) => {
            const changed = stage !== value
            stage = value
            progress = valueProgress
            const previousDetail = detail
            detail = valueDetail ?? {}
            if (
              changed ||
              previousDetail.completed !== detail.completed ||
              JSON.stringify(previousDetail.active) !== JSON.stringify(detail.active) ||
              Date.now() - lastHeartbeat >= 3000
            )
              await beat()
          },
        })
        checkpoint = speech.checkpoint
        content = { text: speech.text, segments: speech.segments, outcome: speech.outcome }
      } else {
        const fingerprint = createHash('sha256')
          .update(
            JSON.stringify([
              job.recording_id,
              job.mode,
              manifest.sha256,
              provider,
              this.config.language,
              splitSeconds,
            ]),
          )
          .digest('hex')
        await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 })
        checkpoint = join(this.config.stateDir, `api-${fingerprint}.json`)
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
        stage = 'decoding'
        detail = {}
        await beat()
        controller.signal.throwIfAborted()
        await audioProcess(
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
            String(splitSeconds),
            '-reset_timestamps',
            '1',
            join(directory, 'chunk-%06d.flac'),
          ],
          controller.signal,
        )
        const files = (await readdir(directory))
          .filter((name) => /^chunk-\d+\.flac$/.test(name))
          .sort()
        if (!files.length || chunks.length > files.length)
          throw Error('Audio split does not match transcription checkpoint.')
        for (let i = chunks.length; i < files.length; i++) {
          stage = 'waiting_recognition'
          progress = i / files.length
          detail = {
            completed: i,
            total: files.length,
            active: [
              {
                index: i + 1,
                start_ms: i * splitSeconds * 1000,
                end_ms: Math.round(Math.min((i + 1) * splitSeconds * 1000, manifest.durationMs)),
                attempt: 1,
                state: 'waiting',
              },
            ],
          }
          await beat()
          controller.signal.throwIfAborted()
          const result = await this.recognitionSlots.run(controller.signal, async () => {
            stage = 'waiting_rate_limit'
            await beat()
            await this.pace(controller.signal)
            stage = 'transcribing'
            detail.active![0].state = 'transcribing'
            await beat()
            return this.recognize(join(directory!, files[i]), {
              provider,
              language: this.config.language,
              timeoutMs: this.config.timeoutMs,
              splitSeconds,
            })
          })
          controller.signal.throwIfAborted()
          chunks.push(result)
          await saveCheckpoint(checkpoint, chunks, controller.signal)
        }
        const segments = chunks.flatMap((chunk, index) =>
          Array.isArray(chunk.segments)
            ? chunk.segments.map((segment: any) => ({
                start_ms: index * splitSeconds * 1000 + segment.start_ms,
                end_ms: index * splitSeconds * 1000 + segment.end_ms,
                text: segment.text,
                speaker: segment.speaker ?? null,
              }))
            : [],
        )
        content = {
          text: chunks
            .map((chunk) => chunk.text.trim())
            .filter(Boolean)
            .join('\n'),
          segments,
        }
      }
      stage = 'saving'
      detail = { ...detail, completed: detail.total, active: [] }
      progress = 1
      await beat()
      controller.signal.throwIfAborted()
      const result = { lease_token: job.lease_token, model: provider, ...content }
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
