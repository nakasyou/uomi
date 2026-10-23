import { fixture } from './helpers.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { Buffer } from 'buffer'
import app, { digest, validateChunk } from '../worker/app.ts'
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
    body: data ? JSON.stringify(data) : undefined,
  })
}
test('stage, retry, canonical acknowledgement, fast search and audio are separate', async () => {
  const f = fixture(),
    v = await chunk(),
    headers = { 'Idempotency-Key': v.segmentId }
  let r = await app.fetch(request('/api/chunks', 'POST', v, headers), f.env, f.ctx)
  assert.equal(r.status, 202)
  assert.equal((await r.json()).notion_saved, false)
  await Promise.all(f.tasks)
  assert.equal(f.files.size, 1)
  assert.equal(f.sqlite.prepare('SELECT backup_step FROM recordings').get().backup_step, 'page')
  r = await app.fetch(request('/api/chunks', 'POST', v, headers), f.env, f.ctx)
  assert.equal(r.status, 202)
  f.sqlite
    .prepare(
      "UPDATE recordings SET backup_step='done',text='分散ファクトチェック',status='Completed'",
    )
    .run()
  f.sqlite.prepare('INSERT INTO transcripts VALUES(?,?)').run(v.segmentId, '分散ファクトチェック')
  r = await app.fetch(request('/api/chunks', 'POST', v, headers), f.env, f.ctx)
  assert.equal((await r.json()).notion_saved, true)
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
  await assert.rejects(() => validateChunk({ ...v, durationMs: 41 }))
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
  assert.equal(r.status, 409)
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
  const call = (method, extra = {}) => app.fetch(new Request('https://uomi.test/api/clients', {
    method,
    headers: { 'oai-authenticated-user-email': 'owner@example.org', ...extra },
  }), f.env, f.ctx)
  assert.equal((await call('GET')).status, 200)
  assert.equal((await call('POST', { Origin: 'https://other.test' })).status, 403)
  f.sqlite.close()
})
