import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './helpers.js'
import app from '../worker/app.ts'
import { FakeNotion, SOURCE } from '../../../packages/notion/testing/fake.ts'
import { cachePage } from '../worker/notion-cache.ts'

const pageId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const request = (method, headers = {}) =>
  new Request('https://uomi.test/api/recordings/recording/detailed-transcription', {
    method,
    headers: { 'oai-authenticated-user-id': 'owner', ...headers },
  })
test('owner requests one durable Codex job, polls its full result, and keeps the standard transcript', async () => {
  const f = fixture()
  const fake = new FakeNotion()
  const original = globalThis.fetch
  const wakeups = []
  const page = {
    id: pageId,
    parent: { data_source_id: SOURCE },
    properties: {
      'Recording ID': { rich_text: [{ text: { content: 'recording' } }] },
      Status: { select: { name: 'Completed' } },
      Audio: { files: [{ file: { url: 'https://files.example/audio' } }] },
      Manifest: { files: [{ file: { url: 'https://files.example/manifest' } }] },
    },
  }
  fake.pages.set(pageId, page)
  f.env.NOTION_TOKEN = 'private'
  f.env.NOTION_DATA_SOURCE_ID = SOURCE
  f.env.TRANSCRIBER_WEBHOOK_URL = 'https://daemon.example/webhook'
  f.env.UOMI_WEBHOOK_SECRET = 'server-only-secret-at-least-24-characters'
  f.sqlite
    .prepare(
      "INSERT INTO recordings(id,edited_at,device,status,url,text,backup_step,backup_page) VALUES('recording','','omi','Completed','','Chrome transcript','done',?)",
    )
    .run(pageId)
  globalThis.fetch = async (url, init) => {
    if (String(url) === f.env.TRANSCRIBER_WEBHOOK_URL) {
      wakeups.push(init)
      return new Response('Unavailable', { status: 503 })
    }
    if (String(url) === 'https://files.example/detailed')
      return Response.json({
        schema: 'uomi.transcript.v1',
        provider: 'codex',
        text: 'Detailed full text',
      })
    return Response.json(
      await fake.transport({
        path: new URL(url).pathname.replace('/v1', ''),
        method: init.method,
        body: init.body ? JSON.parse(init.body) : undefined,
      }),
    )
  }
  try {
    const first = await app.fetch(request('POST'), f.env, f.ctx)
    assert.equal(first.status, 202)
    assert.equal((await first.json()).detailed_status, 'Pending')
    await Promise.all(f.tasks)
    assert.equal(wakeups.length, 1)
    assert.deepEqual(JSON.parse(wakeups[0].body), { pageId, mode: 'detailed' })
    assert.equal(
      wakeups[0].headers.Authorization,
      'Bearer server-only-secret-at-least-24-characters',
    )
    assert.equal(wakeups[0].redirect, 'error')
    assert.equal(page.properties['Detailed status'].select.name, 'Pending')
    await app.fetch(request('POST'), f.env, f.ctx)
    assert.equal(
      fake.requests.filter((r) => r.path.startsWith('/pages/') && r.method === 'PATCH').length,
      1,
    )
    assert.equal(page.properties.Status.select.name, 'Completed')
    Object.assign(page.properties, {
      'Detailed status': { select: { name: 'Completed' } },
      'Detailed preview': { rich_text: [{ text: { content: 'short preview' } }] },
      'Detailed transcript': { files: [{ file: { url: 'https://files.example/detailed' } }] },
    })
    const callback = await app.fetch(
      new Request('https://uomi.test/api/transcriber/completed', {
        method: 'POST',
        headers: { 'X-Uomi-Webhook-Secret': f.env.UOMI_WEBHOOK_SECRET },
        body: JSON.stringify({ pageId, mode: 'detailed' }),
      }),
      f.env,
      f.ctx,
    )
    assert.equal(callback.status, 200)
    assert.equal((await callback.json()).saved, true)
    const polled = await app.fetch(request('GET'), f.env, f.ctx)
    assert.equal((await polled.json()).detailed_text, 'Detailed full text')
    const row = f.sqlite.prepare('SELECT * FROM recordings').get()
    assert.equal(row.text, 'Chrome transcript')
    assert.equal(row.detailed_text, 'Detailed full text')
    // The same fields must survive a complete cache rebuild from Notion.
    delete page.properties.Audio
    delete page.properties.Manifest
    page.properties['Transcript preview'] = {
      rich_text: [{ text: { content: 'Chrome transcript' } }],
    }
    await cachePage(f.env, page)
    assert.equal(
      f.sqlite.prepare('SELECT detailed_text FROM recordings').get().detailed_text,
      'Detailed full text',
    )
    f.sqlite.prepare("UPDATE recordings SET backup_step='audio'").run()
    const pending = await app.fetch(request('POST'), f.env, f.ctx)
    assert.equal(pending.status, 400)
    assert.match((await pending.json()).error, /finish saving/)
  } finally {
    globalThis.fetch = original
    f.sqlite.close()
  }
})

test('device keys cannot start Codex jobs and cross-origin writes are rejected', async () => {
  const f = fixture()
  const key = 'device-key-with-at-least-24-characters'
  const hash = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)),
  ).toString('hex')
  f.sqlite.prepare('INSERT INTO client_keys(hash,name,created_at) VALUES(?,?,0)').run(hash, 'phone')
  f.sqlite
    .prepare(
      "INSERT INTO recordings(id,edited_at,device,status,url,text) VALUES('recording','','omi','Completed','','')",
    )
    .run()
  try {
    const client = new Request(
      'https://uomi.test/api/recordings/recording/detailed-transcription',
      { method: 'POST', headers: { 'X-Uomi-Secret': key } },
    )
    assert.equal((await app.fetch(client, f.env, f.ctx)).status, 403)
    assert.equal(
      (await app.fetch(request('POST', { Origin: 'https://other.test' }), f.env, f.ctx)).status,
      403,
    )
  } finally {
    f.sqlite.close()
  }
})
