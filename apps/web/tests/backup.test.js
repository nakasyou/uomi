import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './helpers.js'
import { backup } from '../worker/app.ts'
import { saveManifest } from '../worker/manifest.ts'
import { FakeNotion, SOURCE } from '../../../packages/notion/testing/fake.ts'
test('legacy dirty backup resumes transcript or page lookup instead of silently retaining legacy forever', async () => {
  const f = fixture(),
    original = globalThis.fetch,
    fake = new FakeNotion()
  Object.assign(f.env, { NOTION_TOKEN: 'token', NOTION_DATA_SOURCE_ID: SOURCE })
  globalThis.fetch = async (url, init) => {
    const request = { path: new URL(url).pathname.replace('/v1', ''), method: init.method }
    if (init.body instanceof FormData) {
      const file = init.body.get('file')
      request.upload = {
        filename: file.name,
        contentType: file.type,
        base64: Buffer.from(await file.arrayBuffer()).toString('base64'),
      }
    } else if (init.body) request.body = JSON.parse(init.body)
    return Response.json(await fake.transport(request))
  }
  try {
    for (const [id, knownPage] of [
      ['legacy-known', true],
      ['legacy-lookup', false],
    ]) {
      const pageId = knownPage ? 'a'.repeat(32) : 'b'.repeat(32)
      fake.pages.set(pageId, {
        id: pageId,
        parent: { data_source_id: SOURCE },
        url: 'https://notion.so/' + pageId,
        properties: {
          'Recording ID': { rich_text: [{ text: { content: id } }] },
          Status: { select: { name: 'Completed' } },
        },
      })
      const key = await saveManifest(f.env, {
        schema: 'uomi.notion.v1',
        id,
        deviceId: 'phone',
        capturedAt: null,
        durationMs: 20,
        sha256: 'f'.repeat(64),
        frameIds: ['ring:0'],
        timing: [],
      })
      f.sqlite
        .prepare(
          "INSERT INTO recordings(id,edited_at,device,status,url,text,audio_key,manifest_key,backup_step,backup_page,revision,backup_revision) VALUES(?,'now','phone','Completed','','Primary result','missing-audio',?,'legacy',?,1,0)",
        )
        .run(id, key, knownPage ? pageId : null)
      await backup(f.env, id)
      const row = f.sqlite.prepare('SELECT * FROM recordings WHERE id=?').get(id)
      if (knownPage) {
        assert.equal(row.backup_step, 'done')
        assert.equal(row.backup_revision, 1)
        assert.equal(row.backup_error, null)
      } else {
        assert.equal(row.backup_step, 'audio')
        assert.equal(row.backup_page, pageId)
        assert.match(row.backup_error, /Saved audio is unavailable/)
        assert.ok(row.backup_next_attempt > Date.now())
      }
    }
  } finally {
    globalThis.fetch = original
    f.sqlite.close()
  }
})
