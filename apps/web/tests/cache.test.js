import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cachePage } from '../worker/notion-cache.ts'
// Source recovery validates manifests and audio before admitting the cache write.
test('a malformed canonical manifest cannot replace a persistent cache', async () => {
  const original = globalThis.fetch
  let wrote = false
  globalThis.fetch = async () => Response.json({ schema: 'invalid' })
  const env = {
    NOTION_TOKEN: 'token',
    NOTION_DATA_SOURCE_ID: 'a'.repeat(32),
    DB: {
      prepare() {
        return {
          bind() {
            return this
          },
          first: async () => null,
        }
      },
      batch: async () => {
        wrote = true
      },
    },
    BUCKET: {
      put: async () => {
        wrote = true
      },
    },
  }
  const page = {
    id: 'b'.repeat(32),
    properties: {
      Manifest: { files: [{ file: { url: 'https://example.test/manifest' } }] },
      Audio: { files: [{ file: { url: 'https://example.test/audio' } }] },
    },
  }
  try {
    await assert.rejects(() => cachePage(env, page), /Invalid audio manifest/)
    assert.equal(wrote, false)
  } finally {
    globalThis.fetch = original
  }
})

test('Notion source can rebuild audio, transcript and metadata into empty caches', async () => {
  const { oggOpus } = await import('@uomi/audio'),
    { createHash } = await import('node:crypto')
  const original = globalThis.fetch,
    audio = oggOpus([{ id: 'frame:0', data: 'mAE=', durationMs: 20, offsetMs: 0 }]),
    sha = createHash('sha256').update(audio).digest('hex')
  const manifest = {
    schema: 'uomi.notion.v1',
    id: 'canonical',
    deviceId: 'omi',
    capturedAt: '2026-10-23T00:00:00Z',
    durationMs: 20,
    sha256: sha,
    frameIds: ['frame:0'],
    timing: [],
  }
  globalThis.fetch = async (url) =>
    String(url).endsWith('/manifest')
      ? Response.json(manifest)
      : String(url).endsWith('/transcript')
        ? Response.json({ schema: 'uomi.transcript.v1', text: 'Notion is canonical' })
        : new Response(audio)
  let savedAudio, batch
  const env = {
    NOTION_TOKEN: 'token',
    NOTION_DATA_SOURCE_ID: 'a'.repeat(32),
    DB: {
      prepare(sql) {
        return {
          sql,
          bind(...args) {
            this.args = args
            return this
          },
          first: async () => null,
        }
      },
      batch: async (statements) => {
        batch = statements
      },
    },
    BUCKET: {
      put: async (key, value) => {
        if (key.startsWith('audio/')) savedAudio = value
      },
    },
  }
  const files = (name) => ({ files: [{ file: { url: 'https://example.test/' + name } }] })
  const page = {
    id: 'b'.repeat(32),
    last_edited_time: '2026-10-23T01:00:00Z',
    properties: {
      'Recording ID': { rich_text: [{ plain_text: 'canonical' }] },
      Name: { type: 'title', title: [{ plain_text: 'Recovered' }] },
      'Recorded at': { date: { start: manifest.capturedAt } },
      'Duration (s)': { number: 0.02 },
      Status: { select: { name: 'Completed' } },
      Manifest: files('manifest'),
      Audio: files('audio'),
      Transcript: files('transcript'),
    },
  }
  try {
    const result = await cachePage(env, page)
    assert.equal(result.cached, true)
    assert.deepEqual(Buffer.from(savedAudio), audio)
    assert.equal(batch[0].args[7], 'Notion is canonical')
    assert.equal(batch[0].args[0], 'canonical')
    assert.equal(batch[0].args[12], 'Recovered')
  } finally {
    globalThis.fetch = original
  }
})

test('resync is resumable, partitions capped results and invalidates archived source pages', async () => {
  const { fixture } = await import('./helpers.js'),
    { resync } = await import('../worker/notion-cache.ts')
  const f = fixture(),
    original = globalThis.fetch
  f.env.NOTION_TOKEN = 'token'
  f.env.NOTION_DATA_SOURCE_ID = 'a'.repeat(32)
  let capped = true,
    queries = 0
  const page = {
    id: 'b'.repeat(32),
    created_time: '2026-10-01T00:00:00Z',
    last_edited_time: '2026-10-23T00:00:00Z',
    properties: {
      'Recording ID': { rich_text: [{ plain_text: 'restored' }] },
      Name: { type: 'title', title: [{ plain_text: 'Restored recording' }] },
      'Recorded at': { date: { start: '2026-10-23T00:00:00Z' } },
      'Duration (s)': { number: 20 },
      'Transcript preview': { rich_text: [{ plain_text: 'Source text' }] },
    },
  }
  globalThis.fetch = async (url, init) => {
    if (!String(url).endsWith('/query')) return Response.json({})
    queries++
    if (capped) {
      capped = false
      return Response.json({ request_status: { type: 'incomplete' }, results: [], has_more: false })
    }
    const body = JSON.parse(init.body)
    return Response.json({
      results: [body.is_archived ? { ...page, archived: true } : page],
      has_more: false,
    })
  }
  try {
    let r = await resync(f.env, true)
    assert.equal(r.has_more, true)
    assert.equal(r.processed, 0)
    assert.equal(
      JSON.parse(f.sqlite.prepare('SELECT cursor FROM resync_state').get().cursor).windows.length,
      2,
    )
    for (let i = 0; i < 5 && r.has_more; i++) r = await resync(f.env)
    assert.equal(r.has_more, false)
    assert.ok(queries >= 4)
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM recordings').get().n, 0)
  } finally {
    globalThis.fetch = original
    f.sqlite.close()
  }
})
