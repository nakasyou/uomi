import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './helpers.js'
import app from '../worker/app.ts'
import { backupState } from '../worker/backup-state.ts'
import { storageDiagnostics } from '../worker/storage-diagnostics.ts'
const configured = { NOTION_TOKEN: 'token', NOTION_DATA_SOURCE_ID: 'source' }
const base = {
  audio_key: 'audio',
  backup_step: 'done',
  backup_error: null,
  backup_until: 0,
  revision: 2,
  backup_revision: 2,
}
test('backup checkpoint alone cannot confirm a current revision or an unconfigured/missing-audio backup', () => {
  assert.equal(backupState(configured, base).backup_status, 'saved')
  assert.equal(backupState(configured, { ...base, backup_revision: 1 }).backup_status, 'pending')
  assert.equal(backupState(configured, { ...base, backup_revision: 1 }).backup_saved, false)
  assert.equal(backupState({}, base).backup_status, 'disabled')
  assert.equal(backupState({}, base).backup_saved, false)
  assert.equal(backupState(configured, { ...base, audio_key: null }).backup_status, 'missing_audio')
  assert.equal(
    backupState(configured, { ...base, backup_step: 'uncertain', backup_revision: 1 })
      .backup_status,
    'uncertain',
  )
  assert.equal(
    backupState(configured, { ...base, backup_revision: 1, backup_error: 'HTTP 429' })
      .backup_status,
    'retry',
  )
  assert.equal(
    backupState(configured, { ...base, backup_revision: 1, backup_until: 100 }, 1).backup_status,
    'processing',
  )
})
const request = (path, data, method = data ? 'POST' : 'GET') =>
  new Request('https://uomi.test' + path, {
    method,
    headers: { 'oai-authenticated-user-id': 'owner' },
    ...(data ? { body: JSON.stringify(data) } : {}),
  })
async function response(f, path, data, method) {
  const r = await app.fetch(request(path, data, method), f.env, f.ctx)
  assert.equal(r.status, 200, await r.clone().text())
  return r.json()
}
test('detail/list/lightweight/chunk APIs consistently separate primary save from optional backup revision/configuration', async () => {
  const f = fixture(),
    id = 'a'.repeat(64)
  f.sqlite
    .prepare(
      "INSERT INTO recordings(id,edited_at,device,status,url,text,audio_key,revision,backup_revision,backup_step) VALUES(?,'old','phone','Completed','','Primary text','audio',2,1,'done')",
    )
    .run(id)
  Object.assign(f.env, configured)
  try {
    const detail = await response(f, '/api/recordings/' + id),
      list = (await response(f, '/api/recordings')).results[0],
      state = await response(f, '/api/recordings/' + id + '/status'),
      chunk = (await response(f, '/api/chunks/status', { ids: [id] })).uploads[0]
    for (const r of [detail, list, state, chunk]) {
      assert.equal(r.backup_status, 'pending')
      assert.equal(r.backup_saved, false)
      assert.equal(r.backup_step, 'done')
      assert.equal(r.backup_revision, 1)
      assert.equal(r.revision, 2)
    }
    assert.equal(chunk.status, 'saved')
    f.sqlite.prepare('UPDATE recordings SET backup_revision=revision').run()
    assert.equal((await response(f, '/api/recordings/' + id + '/status')).backup_status, 'saved')
    delete f.env.NOTION_TOKEN
    assert.equal((await response(f, '/api/recordings/' + id + '/status')).backup_status, 'disabled')
  } finally {
    await Promise.all(f.tasks)
    f.sqlite.close()
  }
})
test('concurrent disjoint metadata patches preserve both fields and return atomic revision/time snapshots', async () => {
  const f = fixture()
  f.sqlite
    .prepare(
      "INSERT INTO recordings(id,edited_at,device,status,url,text,title) VALUES('record','old','phone','Completed','','','Old')",
    )
    .run()
  const original = f.env.DB.prepare
  let reads = 0,
    release
  const barrier = new Promise((resolve) => (release = resolve))
  f.env.DB.prepare = (sql) => {
    const statement = original(sql)
    if (sql === 'SELECT * FROM recordings WHERE id=?') {
      const first = statement.first
      statement.first = async () => {
        const row = await first.call(statement)
        reads++
        if (reads === 2) release()
        await barrier
        return row
      }
    }
    return statement
  }
  try {
    const results = await Promise.all([
      response(f, '/api/recordings/record', { title: 'Renamed' }, 'PATCH'),
      response(f, '/api/recordings/record', { starred: true }, 'PATCH'),
    ])
    const row = f.sqlite.prepare('SELECT * FROM recordings').get()
    assert.equal(row.title, 'Renamed')
    assert.equal(row.starred, 1)
    assert.equal(row.revision, 2)
    assert.notEqual(row.edited_at, 'old')
    assert.deepEqual(results.map((x) => x.revision).sort(), [1, 2])
    for (const result of results) {
      assert.equal(result.saved, true)
      assert.equal(typeof result.starred, 'boolean')
      assert.ok(result.updated_at)
    }
    const latest = results.find((x) => x.revision === 2)
    assert.equal(latest.title, 'Renamed')
    assert.equal(latest.starred, true)
  } finally {
    await Promise.all(f.tasks)
    f.sqlite.close()
  }
})
test('explicit source diagnostics report cardinality/payload/allocation; unsupported PRAGMAs are explicit nonfatal errors', async () => {
  const f = fixture()
  f.sqlite
    .prepare(
      "INSERT INTO recordings(id,edited_at,device,status,url,text) VALUES('record','old','phone','Completed','','')",
    )
    .run()
  f.sqlite
    .prepare("INSERT INTO source_ranges VALUES('phone','hash-a:',0,5,1),('phone','hash-b:',0,4,1)")
    .run()
  try {
    let diagnostics = await storageDiagnostics(f.env)
    assert.equal(diagnostics.source_ranges.ranges, 2)
    assert.equal(diagnostics.source_ranges.frames, 9)
    assert.equal(diagnostics.source_ranges.distinct_prefixes, 2)
    assert.equal(diagnostics.source_ranges.ranges_starting_at_zero, 2)
    assert.equal(diagnostics.source_ranges.prefix_utf8_bytes, 14)
    assert.equal(
      diagnostics.allocation.allocated_bytes,
      diagnostics.allocation.page_count * diagnostics.allocation.page_size,
    )
    const original = f.env.DB.prepare
    f.env.DB.prepare = (sql) => {
      if (sql.startsWith('PRAGMA ')) throw Error('not authorized')
      return original(sql)
    }
    diagnostics = await storageDiagnostics(f.env)
    assert.equal(diagnostics.source_ranges.ranges, 2)
    assert.equal(diagnostics.allocation.page_count, null)
    assert.match(diagnostics.allocation.errors.page_count, /not authorized/)
  } finally {
    f.sqlite.close()
  }
})

test('retrying an unconfigured or missing-audio backup returns an actionable error rather than accepting a no-op', async () => {
  const f = fixture()
  f.sqlite
    .prepare(
      "INSERT INTO recordings(id,edited_at,device,status,url,text) VALUES('missing','old','phone','Completed','','')",
    )
    .run()
  try {
    let result = await app.fetch(request('/api/recordings/missing/backup', {}), f.env, f.ctx)
    assert.equal(result.status, 503)
    assert.equal((await result.json()).code, 'backup_not_configured')
    Object.assign(f.env, configured)
    result = await app.fetch(request('/api/recordings/missing/backup', {}), f.env, f.ctx)
    assert.equal(result.status, 409)
    assert.equal((await result.json()).code, 'audio_unavailable')
    assert.equal(f.tasks.length, 0)
  } finally {
    f.sqlite.close()
  }
})
