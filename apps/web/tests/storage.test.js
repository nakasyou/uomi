import { fixture } from './helpers.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'buffer'
import app, { digest, validateChunk } from '../worker/app.ts'
import { oggOpus, encodeOggUpload, decodeOggUpload, OGG_UPLOAD_TYPE } from '@uomi/audio'
import { uploadManifest } from '../../client/src/core/upload.ts'
async function chunk() {
  const frames = [0, 1].map((i) => ({
    id: `omi:ring:1:${i}`,
    data: 'mAE=',
    durationMs: 20,
    offsetMs: i * 20,
    capturedAt: new Date(Date.parse('2026-10-23T00:00:00Z') + i * 20).toISOString(),
    recordTimestamp: 1792713600,
    timing: 'device-utc',
    sequence: '1',
    ringId: 'ring',
  }))
  return {
    schema: 'uomi.audio.v1',
    codec: 'opus',
    sampleRate: 16000,
    channels: 1,
    deviceId: 'omi',
    durationMs: 40,
    frames,
    segmentId: await digest(new TextEncoder().encode(JSON.stringify(frames.map((f) => f.id)))),
  }
}
function request(path, method = 'GET', data, headers = {}) {
  return new Request('https://uomi.test' + path, {
    method,
    headers: { 'oai-authenticated-user-id': 'owner', ...headers },
    ...(method !== 'GET' && data ? { body: JSON.stringify(data) } : {}),
  })
}
test('stage, retry, canonical acknowledgement, fast search and audio are separate', async () => {
  const f = fixture(),
    v = await chunk(),
    headers = { 'Idempotency-Key': v.segmentId }
  let r = await app.fetch(request('/api/chunks', 'POST', v, headers), f.env, f.ctx)
  assert.equal(r.status, 201)
  assert.equal((await r.json()).notion_saved, false)
  await Promise.all(f.tasks)
  assert.equal(f.files.size, 2)
  assert.equal(f.sqlite.prepare('SELECT backup_step FROM recordings').get().backup_step, 'page')
  r = await app.fetch(request('/api/chunks', 'POST', v, headers), f.env, f.ctx)
  assert.equal(r.status, 200)
  f.sqlite
    .prepare(
      "UPDATE recordings SET backup_step='done',text='分散ファクトチェック',status='Completed'",
    )
    .run()
  f.sqlite
    .prepare('UPDATE recordings SET search_text=?,search_version=1 WHERE id=?')
    .run('分散ふぁくとちぇっく', v.segmentId)
  r = await app.fetch(request('/api/chunks', 'POST', v, headers), f.env, f.ctx)
  assert.equal((await r.json()).notion_saved, false)
  r = await app.fetch(request('/api/recordings?q=' + encodeURIComponent('ファクト')), f.env, f.ctx)
  assert.equal((await r.json()).results.length, 1)
  r = await app.fetch(request(`/api/recordings/${v.segmentId}/audio`), f.env, f.ctx)
  assert.equal(r.status, 200)
  assert.equal(
    Buffer.from(await r.arrayBuffer())
      .subarray(0, 4)
      .toString(),
    'OggS',
  )
  await Promise.all(f.tasks)
  f.sqlite.close()
})
test('bad packets, changed payload and overlapping chunk boundaries cannot overwrite source audio', async () => {
  const f = fixture(),
    v = await chunk()
  await assert.rejects(() => validateChunk({ ...v, frames: [{ ...v.frames[0], data: '!' }] }))
  await app.fetch(
    request('/api/chunks', 'POST', v, { 'Idempotency-Key': v.segmentId }),
    f.env,
    f.ctx,
  )
  await Promise.all(f.tasks)
  const overlap = { ...v, frames: v.frames.slice(1), durationMs: 20 }
  overlap.segmentId = await digest(
    new TextEncoder().encode(JSON.stringify(overlap.frames.map((f) => f.id))),
  )
  const r = await app.fetch(
    request('/api/chunks', 'POST', overlap, { 'Idempotency-Key': overlap.segmentId }),
    f.env,
    f.ctx,
  )
  assert.equal(r.status, 200)
  const persisted = await app.fetch(
    request('/api/chunks/status', 'POST', { ids: [overlap.segmentId] }),
    f.env,
    f.ctx,
  )
  assert.equal((await persisted.json()).uploads[0].status, 'saved')
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM recordings').get().n, 1)
  f.sqlite.close()
})
test('authentication, CSRF, device key issue/revoke', async () => {
  const f = fixture()
  let r = await app.fetch(new Request('https://uomi.test/api/recordings'), f.env, f.ctx)
  assert.equal(r.status, 401)
  r = await app.fetch(
    request('/api/clients', 'POST', { name: 'phone' }, { Origin: 'https://evil.test' }),
    f.env,
    f.ctx,
  )
  assert.equal(r.status, 403)
  r = await app.fetch(request('/api/clients', 'POST', { name: 'phone' }), f.env, f.ctx)
  const key = await r.json()
  r = await app.fetch(
    new Request('https://uomi.test/api/recordings', { headers: { 'X-Uomi-Secret': key.secret } }),
    f.env,
    f.ctx,
  )
  assert.equal(r.status, 200)
  await app.fetch(
    request('/api/clients/' + (await digest(new TextEncoder().encode(key.secret))), 'DELETE'),
    f.env,
    f.ctx,
  )
  r = await app.fetch(
    new Request('https://uomi.test/api/recordings', { headers: { 'X-Uomi-Secret': key.secret } }),
    f.env,
    f.ctx,
  )
  assert.equal(r.status, 401)
  f.sqlite.close()
})

test('private Sites email identity supports the viewer and preserves CSRF checks', async () => {
  const f = fixture()
  const call = (method, extra = {}) =>
    app.fetch(
      new Request('https://uomi.test/api/clients', {
        method,
        headers: { 'oai-authenticated-user-email': 'owner@example.org', ...extra },
      }),
      f.env,
      f.ctx,
    )
  assert.equal((await call('GET')).status, 200)
  assert.equal((await call('POST', { Origin: 'https://other.test' })).status, 403)
  f.sqlite.close()
})

test('index status reports storage payloads without assuming D1 physical size is available locally', async () => {
  const f = fixture()
  const response = await app.fetch(
    request('/mcp', 'POST', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'index_status' },
    }),
    f.env,
    f.ctx,
  )
  const rpc = await response.json()
  const status = JSON.parse(rpc.result.content[0].text)
  assert.equal(status.storage.transcript_utf8_bytes, 0)
  assert.equal(status.storage.manifest_gzip_bytes, 0)
  assert.equal(status.storage.database_bytes, null)
  assert.ok(status.storage.fts_data_bytes > 0)
  assert.deepEqual(status.storage.daily, [])
  f.sqlite.close()
})

async function binaryChunk(v) {
  const audio = oggOpus(v.frames)
  const manifest = uploadManifest(v.deviceId, v.frames, v.segmentId, await digest(audio))
  return { audio, manifest }
}
function binaryRequest(manifest, audio) {
  return new Request('https://uomi.test/api/chunks', {
    method: 'POST',
    headers: {
      'oai-authenticated-user-id': 'owner',
      'Content-Type': OGG_UPLOAD_TYPE,
      'Idempotency-Key': manifest.id,
    },
    body: encodeOggUpload(manifest, audio),
  })
}
test('client Ogg is stored byte-for-byte, retries retain canonical acknowledgement and legacy compatibility', async () => {
  const f = fixture(),
    v = await chunk(),
    { audio, manifest } = await binaryChunk(v)
  const response = await app.fetch(binaryRequest(manifest, audio), f.env, f.ctx)
  assert.equal(response.status, 201, await response.clone().text())
  assert.equal((await response.json()).notion_saved, false)
  await Promise.all(f.tasks)
  assert.deepEqual(f.files.get(`audio/${manifest.sha256}.ogg`), audio)
  f.sqlite.prepare("UPDATE recordings SET backup_step='done'").run()
  const retry = await app.fetch(binaryRequest(manifest, audio), f.env, f.ctx)
  assert.equal((await retry.json()).notion_saved, false)
  const legacy = await app.fetch(
    request('/api/chunks', 'POST', v, { 'Idempotency-Key': v.segmentId }),
    f.env,
    f.ctx,
  )
  assert.equal((await legacy.json()).notion_saved, false)
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM recordings').get().n, 1)
  f.sqlite.close()
})
test('Ogg upload accepts more than 1500 source ranges and duration beyond 15 minutes without measuring audio', async () => {
  const f = fixture(),
    v = await chunk()
  v.frames = Array.from({ length: 1687 }, (_, i) => ({
    ...v.frames[0],
    id: `omi:packet${i}:0`,
    sequence: String(i),
  }))
  v.segmentId = await digest(new TextEncoder().encode(JSON.stringify(v.frames.map((f) => f.id))))
  const { audio, manifest } = await binaryChunk(v)
  // Metadata is client-owned; the server neither caps nor recomputes duration.
  manifest.durationMs = 3600000
  const response = await app.fetch(binaryRequest(manifest, audio), f.env, f.ctx)
  assert.equal(response.status, 201, await response.clone().text())
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM source_ranges').get().n, 1687)
  assert.equal(f.sqlite.prepare('SELECT duration_ms FROM recordings').get().duration_ms, 3600000)
  await Promise.all(f.tasks)
  f.sqlite.close()
})
test('binary upload rejects corruption, wrong identities and incomplete metadata before persistence', async () => {
  const f = fixture(),
    { audio, manifest } = await binaryChunk(await chunk())
  const altered = Buffer.from(audio)
  altered[altered.length - 1] ^= 1
  for (const [m, a] of [
    [manifest, altered],
    [{ ...manifest, id: 'bad' }, audio],
    [{ ...manifest, timing: [], frameIds: ['duplicate:0', 'duplicate:0'] }, audio],
  ]) {
    const response = await app.fetch(binaryRequest(m, a), f.env, f.ctx)
    assert.equal(response.status, 400)
  }
  assert.throws(() => decodeOggUpload(Buffer.from([0, 0, 1, 0])))
  assert.equal(f.files.size, 0)
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM recordings').get().n, 0)
  f.sqlite.close()
})
test('binary overlap compares original packets and cannot acknowledge changed source bytes', async () => {
  const f = fixture(),
    v = await chunk(),
    first = await binaryChunk(v)
  await app.fetch(binaryRequest(first.manifest, first.audio), f.env, f.ctx)
  await Promise.all(f.tasks)
  f.sqlite.prepare("UPDATE recordings SET backup_step='done'").run()
  v.frames = v.frames.slice(1)
  v.segmentId = await digest(new TextEncoder().encode(JSON.stringify(v.frames.map((f) => f.id))))
  const subset = await binaryChunk(v)
  const same = await app.fetch(binaryRequest(subset.manifest, subset.audio), f.env, f.ctx)
  assert.equal((await same.json()).notion_saved, false)
  v.frames[0] = { ...v.frames[0], data: 'mAI=' }
  const changed = await binaryChunk(v)
  const different = await app.fetch(binaryRequest(changed.manifest, changed.audio), f.env, f.ctx)
  assert.equal(different.status, 409)
  assert.match((await different.json()).error, /different audio/)
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM recordings').get().n, 1)
  f.sqlite.close()
})

test('metadata-only status distinguishes missing, pending, saved and failed without audio retransmission', async () => {
  const f = fixture(),
    v = await chunk(),
    { audio, manifest } = await binaryChunk(v)
  const missing = 'f'.repeat(64)
  const check = async (ids = [manifest.id, missing]) =>
    app.fetch(request('/api/chunks/status', 'POST', { ids }), f.env, f.ctx)
  assert.equal((await (await check()).json()).uploads[0].status, 'missing')
  await app.fetch(binaryRequest(manifest, audio), f.env, f.ctx)
  await Promise.all(f.tasks)
  f.sqlite.prepare('UPDATE recordings SET backup_error=NULL,backup_until=?').run(Date.now() + 60000)
  let data = await (await check()).json()
  assert.deepEqual(
    data.uploads.map((x) => x.status),
    ['saved', 'missing'],
  )
  f.sqlite.prepare("UPDATE recordings SET backup_error='Notion permission denied'").run()
  data = await (await check()).json()
  assert.equal(data.uploads[0].status, 'saved')
  assert.equal(data.uploads[0].error, null)
  assert.equal(data.uploads[0].backup_error, 'Notion permission denied')
  f.sqlite.prepare("UPDATE recordings SET backup_step='done',backup_error=NULL").run()
  data = await (await check()).json()
  assert.equal(data.uploads[0].status, 'saved')
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM recordings').get().n, 1)
  assert.equal((await check(['bad'])).status, 400)
  assert.equal(
    (
      await app.fetch(
        new Request('https://uomi.test/api/chunks/status', {
          method: 'POST',
          body: JSON.stringify({ ids: [manifest.id] }),
        }),
        f.env,
        f.ctx,
      )
    ).status,
    401,
  )
  f.sqlite.close()
})
