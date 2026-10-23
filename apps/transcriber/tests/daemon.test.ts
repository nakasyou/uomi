import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NotionStore, type AudioManifest } from '@uomi/notion'
import { FakeNotion, SOURCE } from '../../../packages/notion/testing/fake'
import { authorized, Daemon, pageId } from '../src/daemon'
test('webhook authentication and page IDs reject invalid input', () => {
  expect(authorized('Bearer correct', 'correct')).toBe(true)
  expect(authorized('Bearer wrong', 'correct')).toBe(false)
  expect(() => pageId('../../credentials')).toThrow()
})
test('daemon verifies audio, runs ffmpeg, writes transcript to Notion and ignores repeated completed notifications', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'uomi-daemon-test-'))
  const path = join(dir, 'source.ogg')
  const ffmpeg = Bun.spawn(
    [
      'ffmpeg',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=0.1',
      '-c:a',
      'libopus',
      path,
    ],
    { stdout: 'ignore', stderr: 'ignore' },
  )
  expect(await ffmpeg.exited).toBe(0)
  const audio = await readFile(path)
  const fake = new FakeNotion()
  const store = new NotionStore(fake.transport, SOURCE)
  const manifest: AudioManifest = {
    schema: 'uomi.notion.v1',
    id: 'test',
    deviceId: 'omi',
    capturedAt: null,
    durationMs: 100,
    sha256: createHash('sha256').update(audio).digest('hex'),
    frameIds: ['frame'],
    timing: [],
  }
  const page = await store.saveAudio(manifest, audio)
  let callbacks = 0
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (new URL(req.url).pathname === '/api/transcriber/completed') {
        callbacks++
        expect(req.headers.get('X-Uomi-Webhook-Secret')).toBe('test')
        const payload = await req.json() as {pageId:string}
        expect(payload.pageId).toBe(page.id.replaceAll('-',''))
        expect((await store.page(page.id)).properties.Status.select.name).toBe('Completed')
        return Response.json({saved:true})
      }
      const id = new URL(req.url).pathname.slice(1)
      const bytes = fake.files.get(id)
      return bytes ? new Response(new Uint8Array(bytes)) : new Response('', { status: 404 })
    },
  })
  const originalUrl = store.fileUrl.bind(store)
  store.fileUrl = (page, property) =>
    originalUrl(page, property).replace(
      'https://files.example/',
      `http://127.0.0.1:${server.port}/`,
    )
  let calls = 0
  const daemon = new Daemon(
    store,
    {
      secret: 'test',
      sitesCallback: {url:`http://127.0.0.1:${server.port}/api/transcriber/completed`,accessToken:'test-site-token'},
      provider: 'chrome-recognizetion',
      splitSeconds: 900,
      language: 'ja',
      stateDir: join(dir, 'state'),
      requestWaitMs: 0,
      timeoutMs: 300000,
    },
    async (file, options) => {
      expect(options?.splitSeconds).toBe(900)
      expect(options?.provider).toBe('chrome-recognizetion')
      calls++
      expect((await readFile(file)).length).toBeGreaterThan(0)
      return { text: 'Test transcript' }
    },
  )
  try {
    expect(await daemon.accept(page.id)).toEqual({ accepted: true })
    await daemon.close()
    expect(calls).toBe(1)
    expect(callbacks).toBe(1)
    expect((await store.page(page.id)).properties.Status.select.name).toBe('Completed')
    expect(JSON.parse(await fake.attachment(page.id, 'Transcript')).text).toBe('Test transcript')
    const restarted = new Daemon(store, daemon.config)
    expect(await restarted.accept(page.id)).toEqual({ accepted: false, completed: true })
    await restarted.close()
    expect(callbacks).toBe(2)
    expect(calls).toBe(1)
  } finally {
    server.stop(true)
    await rm(dir, { recursive: true, force: true })
  }
})

test('recovery queries stay within Notion nesting limits and defer future retries', async () => {
  const fake = new FakeNotion()
  let query: any
  const future = {
    id: '44444444444444444444444444444444',
    properties: {
      Status: { select: { name: 'Failed' } },
      'Retry after': { date: { start: new Date(Date.now() + 86400000).toISOString() } },
      Audio: { files: [{}] },
      Manifest: { files: [{}] },
    },
  }
  const store = new NotionStore(async (request) => {
    if (request.path.endsWith('/query')) {
      query = (request.body as any).filter
      const depth = (filter: any): number =>
        filter.and || filter.or ? 1 + Math.max(...(filter.and ?? filter.or).map(depth)) : 0
      expect(depth(query)).toBeLessThanOrEqual(2)
      return { results: [future], has_more: false }
    }
    return fake.transport(request)
  }, SOURCE)
  const daemon = new Daemon(store, {
    secret: 'test',
    provider: 'chrome-recognizetion',
    language: 'ja',
    stateDir: '/unused',
    requestWaitMs: 0,
    timeoutMs: 300000,
  })
  expect(await daemon.recover()).toBe(0)
  expect(query.and[0].or.map((entry: any) => entry.select.equals)).toEqual([
    'Pending',
    'Processing',
    'Failed',
  ])
  await daemon.close()
})
