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
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
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
      provider: 'codex',
      language: 'ja',
      stateDir: join(dir, 'state'),
      requestWaitMs: 0,
      timeoutMs: 300000,
    },
    async (file) => {
      calls++
      expect((await readFile(file)).length).toBeGreaterThan(0)
      return { text: 'Test transcript' }
    },
  )
  try {
    expect(await daemon.accept(page.id)).toEqual({ accepted: true })
    await daemon.close()
    expect(calls).toBe(1)
    expect((await store.page(page.id)).properties.Status.select.name).toBe('Completed')
    expect(JSON.parse(await fake.attachment(page.id, 'Transcript')).text).toBe('Test transcript')
    const restarted = new Daemon(store, daemon.config)
    expect(await restarted.accept(page.id)).toEqual({ accepted: false, completed: true })
    await restarted.close()
  } finally {
    server.stop(true)
    await rm(dir, { recursive: true, force: true })
  }
})
