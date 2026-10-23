import { expect, test } from 'bun:test'
import {
  NotionStore,
  notionId,
  httpTransport,
  silenceProperties,
  type AudioManifest,
} from '../src/index'
import { FakeNotion, SOURCE } from '../testing/fake'
const manifest: AudioManifest = {
  schema: 'uomi.notion.v1',
  id: 'stable-audio',
  deviceId: 'omi',
  capturedAt: null,
  durationMs: 100,
  sha256: 'a'.repeat(64),
  frameIds: ['frame-1'],
  timing: [],
}
test('audio is only Pending after both files are attached; retries reuse the page', async () => {
  const fake = new FakeNotion()
  const store = new NotionStore(fake.transport, SOURCE)
  await store.setup()
  const page = await store.saveAudio(manifest, new Uint8Array([1, 2, 3]))
  expect(page.properties.Status.select.name).toBe('Pending')
  expect(page.properties.Audio.files).toHaveLength(1)
  expect(JSON.parse(await fake.attachment(page.id, 'Manifest')).frameIds).toEqual(['frame-1'])
  await store.saveAudio(manifest, new Uint8Array([1, 2, 3]))
  expect(fake.pages.size).toBe(1)
})
test('failed attachment remains Uploading and can be resumed without creating another page', async () => {
  const fake = new FakeNotion()
  const store = new NotionStore(fake.transport, SOURCE)
  fake.failAttach = true
  await expect(store.saveAudio(manifest, new Uint8Array([1]))).rejects.toThrow('503')
  expect([...fake.pages.values()][0].properties.Status.select.name).toBe('Uploading')
  fake.failAttach = false
  await store.saveAudio(manifest, new Uint8Array([1]))
  expect(fake.pages.size).toBe(1)
})
test('full transcripts survive the rich-text preview limit', async () => {
  const fake = new FakeNotion()
  const store = new NotionStore(fake.transport, SOURCE)
  const page = await store.saveAudio(manifest, new Uint8Array([1]))
  const text = 'word '.repeat(3000)
  await store.saveTranscript(page.id, text, 'codex')
  expect(JSON.parse(await fake.attachment(page.id, 'Transcript')).text).toBe(text)
  const saved = await store.page(page.id)
  expect(saved.properties.Status.select.name).toBe('Completed')
  expect(
    saved.properties['Transcript preview'].rich_text.every(
      (v: any) => v.text.content.length <= 2000,
    ),
  ).toBe(true)
})
test('Notion identifiers accept page URLs and reject unrelated strings', () => {
  expect(notionId(`https://notion.so/Audio-${SOURCE}?v=123`)).toBe(SOURCE)
  expect(() => notionId('not-an-id')).toThrow()
})
test('HTTP errors never expose response bodies or connection tokens', async () => {
  const transport = httpTransport(
    'private-token',
    (async () => new Response('private-token', { status: 403 })) as unknown as typeof fetch,
  )
  await expect(transport({ path: '/users/me', method: 'GET' })).rejects.toThrow('Notion HTTP 403')
  try {
    await transport({ path: '/users/me', method: 'GET' })
  } catch (e) {
    expect(String(e)).not.toContain('private-token')
  }
})

test('HTTP redirects are rejected without following or forwarding credentials at the edge', async () => {
  let requests = 0
  const transport = httpTransport('private-token', (async (_url, init) => {
    requests++
    expect(init?.redirect).toBe('manual')
    return new Response(null, { status: 302, headers: { location: 'https://example.org' } })
  }) as typeof fetch)
  await expect(transport({ path: '/users/me', method: 'GET' })).rejects.toThrow('Notion HTTP 302')
  expect(requests).toBe(1)
})

test('record_finished_at includes fractional seconds and stays unset without a device time', async () => {
  const fake = new FakeNotion()
  const store = new NotionStore(fake.transport, SOURCE)
  const unknown = await store.reserve(manifest)
  expect(unknown.properties.record_finished_at.date).toBeNull()
  expect(unknown.properties.recorded_at_ms.number).toBeNull()
  expect(unknown.properties.record_finished_at_ms.number).toBeNull()
  const page = await store.reserve({
    ...manifest,
    id: 'known-time',
    capturedAt: '2026-10-21T12:30:06.080Z',
    durationMs: 179240,
  })
  expect(page.properties.record_finished_at.date.start).toBe('2026-10-21T12:33:05.320Z')
  expect(page.properties.recorded_at_ms.number).toBe(Date.parse('2026-10-21T12:30:06.080Z'))
  expect(page.properties.record_finished_at_ms.number - page.properties.recorded_at_ms.number).toBe(
    179240,
  )
})

test('existing recordings get an end time without changing audio or overwriting an existing end', async () => {
  const fake = new FakeNotion()
  const store = new NotionStore(fake.transport, SOURCE)
  const page = await store.saveAudio(
    { ...manifest, capturedAt: '2026-10-21T12:30:06.080Z' },
    new Uint8Array([1]),
  )
  delete page.properties.record_finished_at
  fake.pages.get(page.id).properties = structuredClone(page.properties)
  const before = structuredClone(page.properties)
  await store.ensureRecordingEnd(page)
  const saved = await store.page(page.id)
  expect(saved.properties.record_finished_at.date.start).toBe('2026-10-21T12:30:06.180Z')
  const { record_finished_at: _, ...unchanged } = saved.properties
  expect(unchanged).toEqual(before)
  const patches = fake.requests.filter((r) => r.method === 'PATCH').length
  await store.ensureRecordingEnd(saved)
  expect(fake.requests.filter((r) => r.method === 'PATCH').length).toBe(patches)
  await store.ensureRecordingEnd({
    ...page,
    properties: { ...page.properties, 'Recorded at': { date: null } },
  })
  expect(fake.requests.filter((r) => r.method === 'PATCH').length).toBe(patches)
})

test('numeric millisecond timestamps backfill existing dates and preserve populated values', async () => {
  const fake = new FakeNotion()
  const store = new NotionStore(fake.transport, SOURCE)
  const page = await store.reserve({ ...manifest, capturedAt: '2026-10-21T12:30:06.080Z' })
  delete page.properties.recorded_at_ms
  delete page.properties.record_finished_at_ms
  fake.pages.get(page.id).properties = structuredClone(page.properties)
  await store.ensureRecordingEnd(page)
  const saved = await store.page(page.id)
  expect(saved.properties.recorded_at_ms.number).toBe(Date.parse('2026-10-21T12:30:06.080Z'))
  expect(saved.properties.record_finished_at_ms.number).toBe(
    Date.parse(saved.properties.record_finished_at.date.start),
  )
  const before = fake.requests.length
  await store.ensureRecordingEnd(saved)
  expect(fake.requests.length).toBe(before)
})

test('request pacing allows a second request to start while the first upload is still running', async () => {
  const { paceTransport } = await import('../src/index')
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const started: number[] = []
  const paced = paceTransport(async (request) => {
    started.push(Date.now())
    if (request.path === '/first') await blocked
    return {}
  }, 5)
  const first = paced({ path: '/first', method: 'GET' })
  try {
    await Promise.race([
      paced({ path: '/second', method: 'GET' }),
      new Promise((_, reject) =>
        setTimeout(() => reject(Error('pacer serialized completion')), 1000),
      ),
    ])
    expect(started.length).toBe(2)
    expect(started[1] - started[0]).toBeGreaterThanOrEqual(4)
  } finally {
    release()
    await first
  }
})

test('capped Notion queries are partitioned by creation time rather than silently losing rows', async () => {
  const fake = new FakeNotion()
  const base = Date.parse('2026-01-01T00:00:00Z')
  for (let i = 0; i < 8; i++)
    fake.pages.set(String(i), {
      id: String(i),
      created_time: new Date(base + i * 86400000).toISOString(),
      properties: {},
    })
  const store = new NotionStore(async (request) => {
    const result = await fake.transport(request)
    if (request.path.endsWith('/query') && result.results.length > 2)
      return {
        ...result,
        results: result.results.slice(0, 2),
        has_more: false,
        request_status: { type: 'incomplete', incomplete_reason: 'query_result_limit_reached' },
      }
    return result
  }, SOURCE)
  expect((await store.query()).map((page) => page.id).sort()).toEqual([
    '0',
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
  ])
})
test('an unsplittable capped timestamp fails explicitly instead of claiming a complete sync', async () => {
  const store = new NotionStore(
    async (request) =>
      request.path.endsWith('/query')
        ? { results: [], has_more: false, request_status: { type: 'incomplete' } }
        : { id: SOURCE },
    SOURCE,
  )
  await expect(store.query()).rejects.toThrow('truncated')
})
test('429 waits and retries without applying unsafe retry rules to ambiguous page creation', async () => {
  const { paceTransport } = await import('../src/index')
  let calls = 0
  const paced = paceTransport(async () => {
    if (++calls === 1) throw Error('Notion HTTP 429; retry after 0s')
    return { ok: true }
  }, 0)
  expect(await paced({ path: '/pages', method: 'POST' })).toEqual({ ok: true })
  let ambiguous = 0
  const unsafe = paceTransport(async () => {
    ambiguous++
    throw Error('Notion HTTP 529')
  }, 0)
  await expect(unsafe({ path: '/pages', method: 'POST' })).rejects.toThrow('529')
  expect(ambiguous).toBe(1)
})

test('synthetic silence has explicit offsets, absolute timestamps, and Notion columns', async () => {
  const value: AudioManifest = {
    ...manifest,
    capturedAt: '2026-10-22T00:00:00.000Z',
    durationMs: 11000,
    gaps: [{ beforeFrame: 1, durationMs: 9000, offsetMs: 1000 }],
  }
  const fake = new FakeNotion()
  const store = new NotionStore(fake.transport, SOURCE)
  const page = await store.saveAudio(value, new Uint8Array([1]))
  expect(page.properties['Synthetic silence (s)'].number).toBe(9)
  expect(page.properties['Synthetic silence count'].number).toBe(1)
  const details = JSON.parse(
    page.properties['Synthetic silence intervals'].rich_text
      .map((v: any) => v.text.content)
      .join(''),
  )
  expect(details.intervals[0]).toMatchObject({
    offset_ms: 1000,
    end_offset_ms: 10000,
    started_at: '2026-10-22T00:00:01.000Z',
    finished_at: '2026-10-22T00:00:10.000Z',
  })
  expect(details.complete).toBe(true)
  expect(JSON.parse(await fake.attachment(page.id, 'Manifest')).gaps).toEqual(value.gaps)
})
test('legacy gaps do not invent absolute times; large interval previews are explicitly bounded', () => {
  const props: any = silenceProperties({
    ...manifest,
    gaps: Array.from({ length: 1000 }, (_, i) => ({ beforeFrame: i, durationMs: 20 })),
  })
  const text = props['Synthetic silence intervals'].rich_text
    .map((v: any) => v.text.content)
    .join('')
  const details = JSON.parse(text)
  expect(details.complete).toBe(false)
  expect(details.total_count).toBe(1000)
  expect(details.intervals[0].started_at).toBeUndefined()
  expect(text.length).toBeLessThan(6000)
})

test('setup reuses source metadata and concurrent uploads share the limit lookup', async () => {
  const fake = new FakeNotion()
  const store = new NotionStore(fake.transport, SOURCE)
  await store.setup()
  await store.setup()
  expect(fake.requests.filter((r) => r.path === `/data_sources/${SOURCE}`)).toHaveLength(1)
  await Promise.all([
    store.upload('one.ogg', 'audio/ogg', new Uint8Array([1])),
    store.upload('two.json', 'application/json', new Uint8Array([2])),
  ])
  expect(fake.requests.filter((r) => r.path === '/users/me')).toHaveLength(1)
})
