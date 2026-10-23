import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ApiWorker, saveCheckpoint, type WorkerConfig, type Job } from '../src/api-worker'

async function fixture(durationSeconds = 0.1) {
  const dir = await mkdtemp(join(tmpdir(), 'uomi-api-test-'))
  const path = join(dir, 'source.ogg')
  const process = Bun.spawn(
    [
      'ffmpeg',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${durationSeconds}`,
      '-c:a',
      'libopus',
      path,
    ],
    { stdout: 'ignore', stderr: 'pipe' },
  )
  expect(await process.exited).toBe(0)
  const audio = await readFile(path)
  const manifest = {
    schema: 'uomi.notion.v1',
    id: 'recording',
    deviceId: 'test',
    capturedAt: null,
    durationMs: durationSeconds * 1000,
    sha256: createHash('sha256').update(audio).digest('hex'),
    frameIds: ['frame'],
    timing: [],
  }
  const fluidCommand = join(dir, 'fake-fluid')
  await writeFile(
    fluidCommand,
    `#!/usr/bin/env bun
const output=process.argv[process.argv.indexOf('--output')+1];
await Bun.write(output, JSON.stringify({schema:'uomi.speech-plan.v1',engine:'test-fluid-v1',duration_ms:${durationSeconds * 1000},segments:[{start_ms:0,end_ms:${durationSeconds * 1000},speaker:'speaker1'}]}));
`,
  )
  await chmod(fluidCommand, 0o700)
  const config: WorkerConfig = {
    url: 'https://api.example',
    fluidCommand,
    secret: 'secret',
    accessToken: 'gateway-token',
    workerId: 'test',
    stateDir: join(dir, 'state'),
    provider: 'chrome-recognizetion',
    language: 'ja',
    concurrency: 2,
    splitSeconds: 600,
    requestWaitMs: 0,
    timeoutMs: 1000,
    pollMs: 1000,
  }
  const job: Job = {
    id: 'job1',
    recording_id: 'recording',
    mode: 'standard',
    lease_token: 'fence',
    lease_until: Date.now() + 180000,
    attempt: 1,
    audio_url: '/audio',
    manifest_url: '/manifest',
    duration_ms: durationSeconds * 1000,
  }
  return { dir, audio, manifest, config, job }
}

test('API worker bounds concurrent claims, reports progress and preserves real segment times', async () => {
  const f = await fixture()
  const calls: { path: string; body: any }[] = []
  let claims = 0
  let recognizes = 0
  const http = (async (url: any, options: any) => {
    expect(options.headers['X-Uomi-Secret']).toBe('secret')
    expect(options.headers['OAI-Sites-Authorization']).toBe('Bearer gateway-token')
    const path = new URL(url).pathname
    const body = options.body ? JSON.parse(options.body) : null
    calls.push({ path, body })
    if (path === '/api/jobs/claim') {
      claims++
      expect(body.limit).toBe(2)
      return Response.json({ jobs: [f.job, { ...f.job, id: 'job2', mode: 'detailed' }] })
    }
    if (path === '/audio') return new Response(f.audio)
    if (path === '/manifest') return Response.json(f.manifest)
    return Response.json({ saved: true })
  }) as unknown as typeof fetch
  const worker = new ApiWorker(
    f.config,
    async (_path, options) => {
      recognizes++
      expect(['codex', 'chrome-recognizetion']).toContain(options?.provider ?? '')
      return {
        text: 'hello',
        segments: [{ start_ms: 0, end_ms: 90, text: 'hello', speaker: 'speaker1' }],
      }
    },
    http,
  )
  try {
    expect(await worker.poll()).toBe(2)
    expect(await worker.poll()).toBe(0)
    await worker.close()
    expect(claims).toBe(1)
    expect(recognizes).toBe(2)
    const completed = calls.filter((call) => call.path.endsWith('/complete'))
    expect(completed).toHaveLength(2)
    expect(completed[0].body.segments[0]).toEqual({
      start_ms: 0,
      end_ms: 90,
      text: 'hello',
      speaker: 'speaker1',
    })
    expect(calls.some((call) => call.body?.stage === 'decoding')).toBe(true)
    expect(calls.some((call) => call.body?.stage === 'transcribing')).toBe(true)
    expect(calls.some((call) => call.body?.stage === 'saving')).toBe(true)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('checksum errors are visible and submitted to durable failure state without provider work', async () => {
  const f = await fixture()
  let reported: any
  const worker = new ApiWorker(
    f.config,
    async () => {
      throw Error('must not recognize')
    },
    (async (url: any, options: any) => {
      const path = new URL(url).pathname
      if (path === '/api/jobs/claim') return Response.json({ jobs: [f.job] })
      if (path === '/audio') return new Response('corrupt')
      if (path === '/manifest') return Response.json(f.manifest)
      if (path.endsWith('/fail')) reported = JSON.parse(options.body)
      return Response.json({ saved: true })
    }) as unknown as typeof fetch,
  )
  try {
    await worker.poll()
    await worker.close()
    expect(reported.error).toContain('Audio checksum mismatch')
    expect(reported.lease_token).toBe('fence')
    expect(worker.lastError).toContain('checksum')
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('lease fencing aborts processing and does not fail a job owned by another worker', async () => {
  const f = await fixture()
  const paths: string[] = []
  const worker = new ApiWorker(
    f.config,
    async () => {
      throw Error('must not recognize')
    },
    (async (url: any) => {
      const path = new URL(url).pathname
      paths.push(path)
      if (path === '/api/jobs/claim') return Response.json({ jobs: [f.job] })
      return Response.json({ error: 'lease expired' }, { status: 409 })
    }) as unknown as typeof fetch,
  )
  try {
    await worker.poll()
    await worker.close()
    expect(paths).toEqual(['/api/jobs/claim', '/api/jobs/job1/heartbeat'])
    expect(worker.lastError).toContain('409')
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('API claim diagnostics retain HTTP status and response detail', async () => {
  const f = await fixture()
  const worker = new ApiWorker(f.config, undefined, (async () =>
    Response.json(
      { error: 'database unavailable', request_id: 'request123' },
      { status: 503 },
    )) as unknown as typeof fetch)
  try {
    await expect(worker.poll()).rejects.toThrow('database unavailable')
    expect(worker.lastError).toContain('request123')
    expect(worker.lastError).toContain('503')
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('a lost completion response retries the same lease without repeating recognition', async () => {
  const f = await fixture()
  let recognized = 0
  let completed = 0
  const receipts: any[] = []
  const worker = new ApiWorker(
    f.config,
    async () => {
      recognized++
      return { text: 'saved transcript' }
    },
    (async (url: any, options: any) => {
      const path = new URL(url).pathname
      if (path === '/api/jobs/claim') return Response.json({ jobs: [f.job] })
      if (path === '/audio') return new Response(f.audio)
      if (path === '/manifest') return Response.json(f.manifest)
      if (path.endsWith('/complete')) {
        completed++
        receipts.push(JSON.parse(options.body))
        if (completed === 1)
          return Response.json({ error: 'response interrupted' }, { status: 503 })
      }
      return Response.json({ saved: true })
    }) as unknown as typeof fetch,
  )
  try {
    await worker.poll()
    await worker.close()
    expect(recognized).toBe(1)
    expect(completed).toBe(2)
    expect(receipts[0]).toEqual(receipts[1])
    expect(worker.lastError).toBeNull()
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('restart reuses checkpointed recognition after a save failure', async () => {
  const f = await fixture()
  let recognized = 0
  let rejectSave = true
  let failed: string | undefined
  const http = (async (url: any, options: any) => {
    const path = new URL(url).pathname
    if (path === '/api/jobs/claim') return Response.json({ jobs: [f.job] })
    if (path === '/audio') return new Response(f.audio)
    if (path === '/manifest') return Response.json(f.manifest)
    if (path.endsWith('/complete') && rejectSave)
      return Response.json({ error: 'storage validation failed' }, { status: 400 })
    if (path.endsWith('/fail')) failed = JSON.parse(options.body).error
    return Response.json({ saved: true })
  }) as unknown as typeof fetch
  const recognize = async () => {
    recognized++
    return { text: 'checkpointed text' }
  }
  try {
    const first = new ApiWorker(f.config, recognize, http)
    await first.poll()
    await first.close()
    expect(failed).toContain('saving:')
    expect(failed).toContain('storage validation failed')
    rejectSave = false
    const restarted = new ApiWorker(f.config, recognize, http)
    await restarted.poll()
    await restarted.close()
    expect(recognized).toBe(1)
    expect(restarted.lastError).toBeNull()
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('worker completes real web API queue through audio, manifest, heartbeat and saved result', async () => {
  const f = await fixture()
  const load = (relative: string) => import(new URL(relative, import.meta.url).href)
  const [{ fixture: databaseFixture }, { default: app }, { enqueue }, { saveManifest }] =
    await Promise.all([
      load('../../web/tests/helpers.js'),
      load('../../web/worker/app.ts'),
      load('../../web/worker/jobs.ts'),
      load('../../web/worker/manifest.ts'),
    ])
  const db = databaseFixture()
  f.config.secret = 'private-worker-secret-at-least-24-chars'
  db.env.UOMI_WORKER_SECRET = f.config.secret
  const key = await saveManifest(db.env, f.manifest)
  await db.env.BUCKET.put('audio/test.ogg', f.audio)
  db.sqlite
    .prepare(
      "INSERT INTO recordings(id,edited_at,device,status,url,text,audio_key,duration_ms,manifest_key,primary_owned) VALUES(?,'now','test','Pending','','','audio/test.ogg',100,?,1)",
    )
    .run('legacy-page', key)
  await enqueue(db.env, 'legacy-page')
  const http = (async (url: any, options: any) => {
    return app.fetch(new Request(url, options), db.env, db.ctx)
  }) as unknown as typeof fetch
  const worker = new ApiWorker(
    f.config,
    async () => ({
      text: 'real API transcript',
      segments: [{ start_ms: 0, end_ms: 90, text: 'real API transcript', speaker: 'person' }],
    }),
    http,
  )
  try {
    expect(await worker.poll()).toBe(1)
    await worker.close()
    const row = db.sqlite.prepare('SELECT * FROM recordings WHERE id=?').get('legacy-page')
    const job = db.sqlite.prepare('SELECT * FROM transcription_jobs').get()
    expect(row.status).toBe('Completed')
    expect(row.text).toBe('real API transcript')
    expect(JSON.parse(row.transcript_segments)[0].speaker).toBe('speaker1')
    expect(job.stage).toBe('completed')
    expect(job.progress).toBe(1)
    expect(job.status).toBe('completed')
    expect(worker.lastError).toBeNull()
  } finally {
    db.sqlite.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('one transient heartbeat outage does not discard a valid lease or repeat work', async () => {
  const f = await fixture()
  let heartbeat = 0
  let completed = false
  const worker = new ApiWorker(f.config, async () => ({ text: 'recovered heartbeat' }), (async (
    url: any,
  ) => {
    const path = new URL(url).pathname
    if (path === '/api/jobs/claim') return Response.json({ jobs: [f.job] })
    if (path === '/audio') return new Response(f.audio)
    if (path === '/manifest') return Response.json(f.manifest)
    if (path.endsWith('/heartbeat') && ++heartbeat === 1)
      return Response.json({ error: 'temporary network failure' }, { status: 503 })
    if (path.endsWith('/complete')) completed = true
    return Response.json({ saved: true })
  }) as unknown as typeof fetch)
  try {
    await worker.poll()
    await worker.close()
    expect(completed).toBe(true)
    expect(worker.lastError).toBeNull()
    expect(heartbeat).toBeGreaterThan(1)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('concurrent lease checkpoints stay atomic, cleanup intermediates, and cancelled owners cannot replace them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'uomi-checkpoint-race-'))
  const path = join(directory, 'checkpoint.json')
  const signal = new AbortController().signal
  try {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        saveCheckpoint(path, [{ text: `lease-${i}:` + 'x'.repeat(100000) }], signal),
      ),
    )
    const saved = JSON.parse(await readFile(path, 'utf8'))
    expect(saved).toHaveLength(1)
    expect(saved[0].text).toMatch(/^lease-[0-7]:x+$/)
    expect(await readdir(directory)).toEqual(['checkpoint.json'])
    const controller = new AbortController()
    controller.abort(Error('lease replaced'))
    await expect(
      saveCheckpoint(path, [{ text: 'stale owner' }], controller.signal),
    ).rejects.toThrow('lease replaced')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(saved)
    expect(await readdir(directory)).toEqual(['checkpoint.json'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Google uses ten-minute chunks, Codex five-minute chunks, with matching original-timeline offsets', async () => {
  const f = await fixture(301)
  const completed: { text: string; segments: { start_ms: number; end_ms: number }[] }[] = []
  const recognized: { provider: string; splitSeconds: number }[] = []
  let claims = 0
  const worker = new ApiWorker(
    f.config,
    async (_path, options) => {
      recognized.push({ provider: options!.provider!, splitSeconds: options!.splitSeconds! })
      return { text: 'test', segments: [{ start_ms: 0, end_ms: 500, text: 'test' }] }
    },
    (async (url: any, options: any) => {
      const path = new URL(url).pathname
      if (path === '/api/jobs/claim')
        return Response.json({
          jobs: claims++ ? [] : [f.job, { ...f.job, id: 'job2', mode: 'detailed' }],
        })
      if (path === '/audio') return new Response(f.audio)
      if (path === '/manifest') return Response.json(f.manifest)
      if (path.endsWith('/complete')) completed.push(JSON.parse(options.body))
      return Response.json({ saved: true })
    }) as typeof fetch,
  )
  try {
    expect(worker.status.splitSeconds).toEqual({ google: 600, codex: 300 })
    await worker.poll()
    await worker.close()
    expect(recognized.filter((r) => r.provider === 'chrome-recognizetion')).toEqual([
      { provider: 'chrome-recognizetion', splitSeconds: 600 },
    ])
    expect(recognized.filter((r) => r.provider === 'codex')).toEqual([
      { provider: 'codex', splitSeconds: 300 },
      { provider: 'codex', splitSeconds: 300 },
    ])
    expect(
      completed.map((r) => r.segments.map((s) => s.start_ms)).sort((a, b) => a.length - b.length),
    ).toEqual([[0], [0, 300000]])
  } finally {
    await worker.close()
    await rm(f.dir, { recursive: true, force: true })
  }
}, 30000)
