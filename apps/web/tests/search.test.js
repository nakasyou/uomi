import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { normalizeSearch } from '../worker/search.js'
import worker, { searchPlan, time } from '../worker/index.js'
function database() {
  const db = new DatabaseSync(':memory:')
  for (const name of ['0000_index.sql','0001_primary.sql','0002_compact.sql']) db.exec(readFileSync(new URL('../drizzle/' + name, import.meta.url), 'utf8'))
  return db
}
function insert(db, id, start, end, text) {
  db.prepare('INSERT INTO recordings(id,recorded_at,finished_at,edited_at,device,status,url,text,search_text,search_version) VALUES(?,?,?,?,?,?,?,?,?,1)').run(
    id,
    start,
    end,
    '2026-01-01',
    'omi',
    'Completed',
    'https://notion.so/test',
    text,
    normalizeSearch(text),
  )
}
test('Japanese substrings, phrase escaping, and SQL injection remain literal', () => {
  const db = database()
  insert(db, 'a', 100, 200, 'これは分散ファクトチェックの研究')
  insert(db, 'b', 200, 300, 'a "quote" and 100% _done')
  for (const [query, id] of [
    ['ファクト', 'a'],
    ['"quote"', 'b'],
    ['100%', 'b'],
  ]) {
    const p = searchPlan({ query })
    assert.equal(db.prepare(p.sql).all(...p.args)[0].id, id)
  }
  const p = searchPlan({ query: "' OR 1=1 --" })
  assert.equal(db.prepare(p.sql).all(...p.args).length, 0)
  assert.throws(() => searchPlan({ query: 'a' }))
  db.close()
})
test('half-open overlap boundaries and keyset pagination', () => {
  const db = database(),
    t = time('2026-10-23T00:00:00Z')
  insert(db, 'a', t, t + 1000, 'first')
  insert(db, 'b', t + 1000, t + 2000, 'second')
  insert(db, 'c', t + 1000, t + 3000, 'third')
  let p = searchPlan({
    from: '2026-10-23T00:00:01Z',
    to: '2026-10-23T00:00:02Z',
    limit: 1,
  })
  let rows = db.prepare(p.sql).all(...p.args)
  assert.deepEqual(
    rows.map((r) => r.id),
    ['b', 'c'],
  )
  p = searchPlan({
    from: '2026-10-23T00:00:01Z',
    to: '2026-10-23T00:00:02Z',
    cursor: btoa(JSON.stringify({ time: t + 1000, id: 'b' })),
  })
  assert.deepEqual(
    db
      .prepare(p.sql)
      .all(...p.args)
      .map((r) => r.id),
    ['c'],
  )
  assert.throws(() => time('2026-10-23'))
  db.close()
})
test('identity required; discovery, tools and tool errors implement MCP', async () => {
  const request = (method, params, auth = true) =>
    new Request('https://example.test/mcp', {
      method: 'POST',
      headers: auth ? { 'oai-authenticated-user-id': 'owner' } : {},
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  assert.equal((await worker.fetch(request('tools/list', {}, false), {})).status, 401)
  let res = await (await worker.fetch(request('server/discover'), {})).json()
  assert.deepEqual(res.result.supportedVersions, ['2026-07-28'])
  res = await (await worker.fetch(request('tools/list'), {})).json()
  assert.equal(res.result.tools.length, 5)
  res = await (
    await worker.fetch(request('tools/call', { name: 'sync_index' }), {
      DB: {},
    })
  ).json()
  assert.equal(res.result.isError, true)
  assert.match(res.result.content[0].text, /Notion credentials/)
})
test('trigram index is used for search', () => {
  const db = database()
  const p = searchPlan({ query: '日本語' })
  assert.match(
    JSON.stringify(db.prepare('EXPLAIN QUERY PLAN ' + p.sql).all(...p.args)),
    /VIRTUAL TABLE INDEX/,
  )
  db.close()
})
test('unknown-clock results paginate without dropping dated recordings', () => {
  const db = database()
  insert(db, 'a', null, null, 'unknown')
  insert(db, 'b', null, null, 'unknown')
  insert(db, 'c', 100, 200, 'dated')
  const p = searchPlan({
    cursor: btoa(JSON.stringify({ time: null, id: 'a' })),
  })
  assert.deepEqual(
    db
      .prepare(p.sql)
      .all(...p.args)
      .map((r) => r.id),
    ['b', 'c'],
  )
  db.close()
})

test('normalized kana, width, case, spaces and two-character literal fallback share search semantics', () => {
  const db = database()
  const raw = '学校 生活 ＣｈａｔＧＰＴ ｶﾀｶﾅ 100% _x'
  insert(db, 'a', 0, 100, raw)
  for (const query of ['学校', '学校生活', 'chat gpt', 'かたかな', 'カタカナ', '０％', '_x']) {
    const p = searchPlan({ query })
    assert.deepEqual(db.prepare(p.sql).all(...p.args).map(x => x.id), ['a'], query)
  }
  for (const query of ['0_', '%x', 'かたなく']) {
    const p = searchPlan({ query })
    assert.equal(db.prepare(p.sql).all(...p.args).length, 0, query)
  }
  assert.equal(db.prepare('SELECT text FROM recordings').get().text, raw)
  const rid = db.prepare('SELECT rid FROM recordings').get().rid
  db.prepare('UPDATE recordings SET text=?,search_text=? WHERE id=?').run('別の原文', normalizeSearch('別の原文'), 'a')
  let p = searchPlan({ query: '学校生活' })
  assert.equal(db.prepare(p.sql).all(...p.args).length, 0)
  p = searchPlan({ query: '別の原文' })
  assert.equal(db.prepare(p.sql).all(...p.args)[0].id, 'a')
  assert.equal(db.prepare('SELECT rid FROM recordings').get().rid, rid)
  db.prepare('DELETE FROM recordings WHERE id=?').run('a')
  assert.equal(db.prepare(p.sql).all(...p.args).length, 0)
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='transcripts_content'").get().n, 0)
  db.close()
})

test('compact positionless index verifies order and multiplicity against normalized source', () => {
  const db = database()
  insert(db, 'a', 0, 100, 'abcdef')
  for (const query of ['abcdef', 'abcabc', 'defabc']) {
    const p = searchPlan({ query })
    assert.equal(db.prepare(p.sql).all(...p.args).length, query === 'abcdef' ? 1 : 0)
  }
  db.close()
})
