import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './helpers.js'
import app from '../worker/app.ts'
test('detailed transcription requires owner; cross-origin writes rejected before work', async () => {
  const f = fixture(),
    key = 'device-key-with-at-least-24-characters'
  const hash = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)),
  ).toString('hex')
  f.sqlite.prepare('INSERT INTO client_keys(hash,name,created_at) VALUES(?,?,0)').run(hash, 'phone')
  f.sqlite
    .prepare(
      "INSERT INTO recordings(id,edited_at,device,status,url,text) VALUES('recording','','phone','Completed','','')",
    )
    .run()
  const path = 'https://uomi.test/api/recordings/recording/detailed-transcription'
  assert.equal(
    (
      await app.fetch(
        new Request(path, { method: 'POST', headers: { 'X-Uomi-Secret': key } }),
        f.env,
        f.ctx,
      )
    ).status,
    403,
  )
  assert.equal(
    (
      await app.fetch(
        new Request(path, {
          method: 'POST',
          headers: { 'oai-authenticated-user-id': 'owner', Origin: 'https://other.test' },
        }),
        f.env,
        f.ctx,
      )
    ).status,
    403,
  )
  assert.equal(
    (
      await app.fetch(
        new Request(path, { method: 'POST', headers: { 'oai-authenticated-user-id': 'owner' } }),
        f.env,
        f.ctx,
      )
    ).status,
    409,
  )
  f.sqlite.close()
})
