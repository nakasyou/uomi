import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { fixture } from './helpers.js'
import { compactManifest, expandManifest, loadManifest } from '../worker/manifest.ts'
import { optimizeCache } from '../worker/maintenance.ts'

test('populated migration preserves public IDs, integer foreign keys, raw text and resumable indexing', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  for (const name of ['0000_index.sql','0001_primary.sql']) db.exec(readFileSync(new URL('../drizzle/' + name, import.meta.url), 'utf8'))
  db.exec("INSERT INTO recordings(id,edited_at,device,status,url,text) VALUES('uuid','now','omi','Completed','','学校 生活'); INSERT INTO source_ranges VALUES('omi','frame:',0,10,'uuid')")
  db.exec(readFileSync(new URL('../drizzle/0002_compact.sql', import.meta.url), 'utf8'))
  const row = db.prepare('SELECT rid,id,text,search_version FROM recordings').get()
  assert.equal(typeof row.rid, 'number')
  assert.equal(row.id, 'uuid')
  assert.equal(row.text, '学校 生活')
  assert.equal(row.search_version, 0)
  assert.equal(db.prepare('SELECT recording_id FROM source_ranges').get().recording_id, row.rid)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  db.close()
  const f = fixture()
  f.sqlite.prepare("INSERT INTO recordings(id,edited_at,device,status,url,text) VALUES(?,?,?,?,?,?)").run('uuid','now','omi','Completed','','学校 生活')
  const result = await optimizeCache(f.env)
  assert.equal(result.search_remaining, 0)
  assert.equal(f.sqlite.prepare('SELECT search_text FROM recordings').get().search_text, '学校生活')
  f.sqlite.close()
})

test('manifest range encoding roundtrips gaps, leading zeros and identities across restart-safe R2 migration', async () => {
  const f = fixture()
  const manifest = { schema: 'uomi.notion.v1', id: 'test', deviceId: 'omi', sha256: 'a'.repeat(64), durationMs: 100,
    capturedAt: null, frameIds: ['frame:0','frame:1','frame:2','frame:04','other'], timing: [], gaps: [] }
  const compact = compactManifest(manifest)
  assert.deepEqual(compact.frame_runs[0], ['frame:',0,3])
  assert.deepEqual(expandManifest(compact), manifest)
  const data = await new Response(new Blob([JSON.stringify(manifest)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
  f.sqlite.prepare("INSERT INTO recordings(id,edited_at,device,status,url,text,manifest_gzip) VALUES(?,?,?,?,?,?,?)").run('test','now','omi','Pending','','',new Uint8Array(data))
  assert.equal((await optimizeCache(f.env)).manifests_remaining, 0)
  const row = f.sqlite.prepare('SELECT * FROM recordings').get()
  assert.equal(row.manifest_gzip, null)
  assert.ok(row.manifest_key.startsWith('manifests/'))
  assert.deepEqual(await loadManifest(f.env,row), manifest)
  f.files.set(row.manifest_key, Buffer.from('broken'))
  await assert.rejects(() => loadManifest(f.env,row), /hash mismatch/)
  f.sqlite.close()
})
