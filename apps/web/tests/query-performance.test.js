import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './helpers.js'
import app, { pendingBackupsSql } from '../worker/app.ts'
import { overlappingRecordingsSql } from '../worker/source-ranges.ts'
import { searchPlan } from '../worker/index.js'
import { cachePage } from '../worker/notion-cache.ts'
const plan = (f, sql, args = []) =>
  f.sqlite
    .prepare('EXPLAIN QUERY PLAN ' + sql)
    .all(...args)
    .map((r) => r.detail)
    .join('\n')
function capture(f) {
  const statements = [],
    original = f.env.DB.prepare
  f.env.DB.prepare = (sql) => {
    const statement = original(sql),
      bind = statement.bind
    let values = []
    statement.bind = function (...v) {
      values = v
      return bind.apply(this, v)
    }
    for (const name of ['first', 'all', 'run']) {
      const execute = statement[name]
      statement[name] = async function () {
        statements.push({ sql, values: [...values] })
        return execute.call(this)
      }
    }
    return statement
  }
  return statements
}
async function call(f, path, data) {
  const response = await app.fetch(
    new Request('https://uomi.test' + path, {
      method: data ? 'POST' : 'GET',
      headers: { 'oai-authenticated-user-id': 'owner' },
      body: data ? JSON.stringify(data) : undefined,
    }),
    f.env,
    f.ctx,
  )
  assert.equal(response.status, 200, await response.clone().text())
  return response.json()
}
function seed(f) {
  const r = f.sqlite
    .prepare(`INSERT INTO recordings(id,recorded_at,finished_at,edited_at,device,status,url,text,search_text,search_version,starred,audio_key,backup_step,backup_revision,revision)
 VALUES(?,?,?,'now','phone','Completed','',?,?,1,?,'audio',?,0,?)`)
  const j = f.sqlite.prepare(
    "INSERT INTO transcription_jobs(id,recording_id,mode,status,created_at,updated_at,available_at,lease_until) VALUES(?,?,'standard',?,?,?,?,?)",
  )
  const s = f.sqlite.prepare(
    'INSERT INTO source_ranges(device,prefix,start,end,recording_id) VALUES(?,?,?,?,?)',
  )
  f.sqlite.exec('BEGIN')
  for (let i = 0; i < 20000; i++) {
    const id = 'r' + String(i).padStart(6, '0'),
      time = i * 60000,
      text = i % 89 === 0 ? '学校の生活' : '日々の記録'
    r.run(
      id,
      time,
      time + 60000,
      text,
      text,
      Number(i % 71 === 0),
      i % 300 === 0 ? 'page' : 'done',
      Number(i % 400 === 0),
    )
    j.run(
      id + ':standard',
      id,
      i % 100 === 0 ? 'processing' : i % 80 === 0 ? 'queued' : 'completed',
      time,
      time,
      i % 160 === 0 ? 0 : 9e15,
      i % 100 === 0 ? 0 : 9e15,
    )
    const rid = Number(f.sqlite.prepare('SELECT rid FROM recordings WHERE id=?').get(id).rid)
    for (let k = 0; k < 3; k++)
      s.run('phone', 'ring' + (i % 100) + ':', i * 100 + k * 20, i * 100 + k * 20 + 10, rid)
  }
  f.sqlite.exec('COMMIT;ANALYZE')
}
test('20k-recording query plans seek cursors/dates/stars, bound job candidates, and retain indexed receipt/import/source lookups', async () => {
  const f = fixture()
  seed(f)
  const statements = capture(f)
  const listPlan = async (path) => {
    statements.length = 0
    await call(f, path)
    const q = statements.find((x) => x.sql.includes(' AS preview FROM recordings'))
    assert.ok(q)
    return plan(f, q.sql, q.values)
  }
  let p = await listPlan('/api/recordings')
  assert.match(p, /recordings_page/)
  assert.doesNotMatch(p, /TEMP B-TREE/)
  const cursor = btoa(JSON.stringify({ time: 600000000, id: 'r010000' }))
  p = await listPlan('/api/recordings?cursor=' + encodeURIComponent(cursor))
  assert.match(p, /SEARCH r USING INDEX recordings_page .*sort_time,id/)
  p = await listPlan('/api/recordings?starred=1')
  assert.match(p, /recordings_starred_newest/)
  assert.doesNotMatch(p, /TEMP B-TREE/)
  p = await listPlan('/api/recordings?from=1970-01-07T22:40:00Z&to=1970-01-08T01:26:40Z')
  assert.match(p, /SEARCH r USING INDEX recordings_page/)
  assert.ok(statements.some((q) => /recordings_end/.test(plan(f, q.sql, q.values))))
  statements.length = 0
  assert.deepEqual((await call(f, '/api/recordings?from=2099-01-01T00:00:00Z')).results, [])
  assert.equal(statements.length, 1)
  assert.match(plan(f, statements[0].sql, statements[0].values), /recordings_end/)
  f.sqlite.exec('UPDATE recordings SET recorded_at=NULL,finished_at=NULL WHERE rid<=1000;ANALYZE')
  p = await listPlan(
    '/api/recordings?cursor=' +
      encodeURIComponent(btoa(JSON.stringify({ time: 0, id: 'r000500' }))),
  )
  assert.match(p, /SEARCH r USING INDEX recordings_page .*sort_time,id/)
  const mcp = searchPlan({ cursor: btoa(JSON.stringify({ time: null, id: 'r000500' })) })
  assert.match(plan(f, mcp.sql, mcp.args), /SEARCH r USING INDEX recordings_page .*sort_time,id/)
  const mcpRows = f.sqlite.prepare(mcp.sql).all(...mcp.args)
  assert.equal(mcpRows[0].id, 'r000501')
  assert.equal(mcpRows[0].recorded_at, null)
  p = await listPlan('/api/recordings?q=' + encodeURIComponent('学校の'))
  assert.match(p, /transcripts VIRTUAL TABLE INDEX/)
  assert.match(p, /SEARCH r USING INTEGER PRIMARY KEY/)
  assert.ok(
    !statements.some((x) => /sum\(|manifest_gzip|SELECT \* FROM recordings/i.test(x.sql)),
    'Ready search must not run migration aggregates or read manifest blobs',
  )
  statements.length = 0
  await call(f, '/api/jobs')
  p = plan(f, statements[0].sql, statements[0].values)
  assert.match(p, /jobs_recent/)
  assert.doesNotMatch(p, /TEMP B-TREE/)
  statements.length = 0
  const claimed = await call(f, '/api/jobs/claim', { worker_id: 'perf', limit: 8 })
  assert.equal(claimed.jobs.length, 8)
  const claim = statements.find((x) => x.sql.includes('WITH candidates AS MATERIALIZED'))
  p = plan(f, claim.sql, claim.values)
  assert.match(p, /jobs_due/)
  assert.match(p, /jobs_expired/)
  assert.doesNotMatch(p, /SCAN j\b/)
  const exhausted = statements.find((x) => x.sql.includes('after maximum attempts'))
  assert.match(plan(f, exhausted.sql, exhausted.values), /jobs_exhausted/)
  assert.ok(
    statements.length <= 5,
    'Claim metadata and status writes must be bounded independently of batch size',
  )
  p = plan(f, pendingBackupsSql, [Date.now(), Date.now()])
  assert.match(p, /backup_due/)
  assert.doesNotMatch(p, /TEMP B-TREE/)
  p = plan(f, overlappingRecordingsSql, [
    JSON.stringify([{ prefix: 'ring0:', start: 10000, end: 10020 }]),
    'phone',
  ])
  assert.match(p, /SEARCH s USING/)
  assert.doesNotMatch(p, /SCAN s\b/)
  assert.match(plan(f, 'DELETE FROM source_ranges WHERE recording_id=?', [123]), /source_recording/)
  statements.length = 0
  await call(f, '/api/chunks/status', { ids: ['a'.repeat(64)] })
  for (const q of statements) {
    p = plan(f, q.sql, q.values)
    assert.doesNotMatch(p, /SCAN (recordings|chunk_aliases|transcription_jobs)\b/)
  }
  statements.length = 0
  await cachePage(f.env, { id: 'r010000', archived: true, properties: {} })
  p = plan(f, statements[0].sql, statements[0].values)
  assert.match(p, /MULTI-INDEX OR/)
  assert.match(p, /notion_page_unique/)
  f.sqlite.close()
})
test('recording status uses one indexed metadata query and never returns full transcript/segment payloads', async () => {
  const f = fixture(),
    large = '長い文字起こし'.repeat(50000)
  f.sqlite
    .prepare(
      "INSERT INTO recordings(id,edited_at,device,status,url,text,detailed_text,transcript_segments,detailed_segments,revision) VALUES('large','now','phone','Completed','',?,?,?,?,17)",
    )
    .run(
      large,
      large,
      JSON.stringify([{ start_ms: 0, end_ms: 20, text: large }]),
      JSON.stringify([{ start_ms: 0, end_ms: 20, text: large }]),
    )
  const statements = capture(f)
  const result = await call(f, '/api/recordings/large/status')
  assert.equal(result.has_audio, false)
  assert.equal(result.revision, 17)
  assert.equal(result.status, 'Completed')
  assert.equal(result.updated_at, 'now')
  assert.equal(statements.length, 1)
  assert.match(plan(f, statements[0].sql, statements[0].values), /SEARCH r USING INDEX/)
  for (const key of ['text', 'detailed_text', 'segments', 'detailed_segments', 'audio'])
    assert.equal(result[key], undefined)
  assert.ok(JSON.stringify(result).length < 1024)
  assert.doesNotMatch(
    statements[0].sql,
    /SELECT \*|\br\.text\b|\br\.detailed_text\b|\br\.transcript_segments\b/,
  )
  const detail = await call(f, '/api/recordings/large')
  assert.equal(detail.revision, result.revision)
  assert.equal(detail.text, large)
  f.sqlite.close()
})

test('provider-specific claims seek per-mode ready and expired indexes with bounded candidate sets', async () => {
  const f = fixture()
  try {
    seed(f)
    f.sqlite.exec(
      "INSERT INTO transcription_jobs(id,recording_id,mode,created_at,updated_at) VALUES('long','r000000','long',1,1),('codex','r000000','detailed',2,2)",
    )
    const statements = capture(f)
    for (const queue of ['chrome', 'codex']) {
      statements.length = 0
      await call(f, '/api/jobs/claim', { worker_id: queue, queue, limit: 2 })
      const query = statements.find((value) =>
        value.sql.includes('WITH candidates AS MATERIALIZED'),
      )
      const explanation = plan(f, query.sql, query.values)
      assert.match(explanation, /SEARCH j USING INDEX jobs_due_mode \(mode=\?/)
      assert.match(explanation, /SEARCH j USING INDEX jobs_expired_mode \(mode=\?/)
      assert.doesNotMatch(explanation, /SCAN j\b/)
      assert.equal((query.sql.match(/LIMIT \?/g) || []).length, queue === 'chrome' ? 5 : 3)
    }
  } finally {
    f.sqlite.close()
  }
})
