import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './helpers.js'
import app, { digest } from '../worker/app.ts'

async function setup() {
  const f = fixture(),
    key = 'capture-client-secret-at-least-24-characters'
  f.sqlite
    .prepare('INSERT INTO client_keys(hash,name,created_at) VALUES(?,?,0)')
    .run(await digest(new TextEncoder().encode(key)), 'api')
  f.env.UOMI_WORKER_SECRET = 'worker-secret-at-least-24-characters'
  for (const id of ['one', 'two', 'no-audio'])
    f.sqlite
      .prepare(
        "INSERT INTO recordings(id,title,edited_at,device,status,url,text,audio_key) VALUES(?,?,'now','phone','Completed','','Previous standard text',?)",
      )
      .run(id, id, id === 'no-audio' ? null : 'audio')
  const api = async (path, data, headers = { 'X-Uomi-Secret': key }) =>
    app.fetch(
      new Request('https://uomi.test' + path, {
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }),
      }),
      f.env,
      f.ctx,
    )
  const rpc = async (name, args = {}, headers) => {
    const response = await api(
      '/mcp',
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      headers,
    )
    const body = await response.json()
    return {
      response,
      body,
      result: body.result?.content
        ? JSON.parse(
            body.result.content[0].text.startsWith('{') ? body.result.content[0].text : '{}',
          )
        : null,
    }
  }
  return { ...f, key, api, rpc }
}

test('MCP detailed starts reuse durable jobs, preserve old text, and explicitly rerun terminal jobs', async () => {
  const f = await setup()
  try {
    let call = await f.rpc('start_detailed_transcription', { id: 'one' })
    assert.equal(call.body.result.isError, undefined)
    assert.equal(call.result.detailed_transcription.mode, 'detailed')
    assert.equal(call.result.detailed_transcription.status, 'queued')
    await f.rpc('start_detailed_transcription', { id: 'one', retry: true })
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM transcription_jobs').get().n, 1)
    f.sqlite
      .prepare(
        "UPDATE transcription_jobs SET status='processing',lease_token='active-lease',attempt=1 WHERE recording_id='one'",
      )
      .run()
    call = await f.rpc('start_detailed_transcription', { id: 'one', retry: true })
    assert.equal(call.result.detailed_transcription.status, 'processing')
    assert.equal(
      f.sqlite.prepare('SELECT lease_token FROM transcription_jobs').get().lease_token,
      'active-lease',
    )
    f.sqlite
      .prepare("UPDATE recordings SET detailed_text='Previous detailed text' WHERE id='one'")
      .run()
    f.sqlite
      .prepare(
        "UPDATE transcription_jobs SET status='completed',stage='completed',attempt=2 WHERE recording_id='one'",
      )
      .run()
    call = await f.rpc('start_detailed_transcription', { id: 'one' })
    assert.equal(call.result.detailed_transcription.status, 'completed')
    call = await f.rpc('start_detailed_transcription', { id: 'one', retry: true })
    assert.equal(call.result.detailed_transcription.status, 'queued')
    assert.equal(call.result.detailed_transcription.attempt, 0)
    assert.equal(
      f.sqlite.prepare("SELECT detailed_text FROM recordings WHERE id='one'").get().detailed_text,
      'Previous detailed text',
    )
    const res = await f.api('/api/recordings/two/detailed-transcription', {})
    assert.equal(res.status, 202)
    assert.equal((await res.json()).detailed_transcription.mode, 'detailed')
    assert.equal((await f.api('/api/recordings/two/detailed-transcription')).status, 200)
  } finally {
    f.sqlite.close()
  }
})

test('API and MCP progress expose mode counts and segment details with bounded keyset pages, without lease secrets', async () => {
  const f = await setup()
  try {
    for (const [id, mode, status, updated] of [
      ['one', 'standard', 'completed', 10],
      ['one', 'detailed', 'processing', 20],
      ['two', 'detailed', 'retry', 20],
    ])
      f.sqlite
        .prepare(
          'INSERT INTO transcription_jobs(id,recording_id,mode,status,created_at,updated_at,stage,progress,progress_detail,lease_token,error) VALUES(?,?,?,?,0,?,?,?,?,?,?)',
        )
        .run(
          id + ':' + mode,
          id,
          mode,
          status,
          updated,
          'transcribing',
          0.5,
          JSON.stringify({ completed: 2, total: 4 }),
          'NEVER-RETURN-THIS',
          status === 'retry' ? 'Provider unavailable' : null,
        )
    const call = await f.rpc('transcription_status', { mode: 'detailed', limit: 1 })
    assert.equal(call.result.jobs.length, 1)
    assert.equal(
      call.result.summary.reduce((n, x) => n + x.count, 0),
      2,
    )
    assert.equal(call.result.jobs[0].recording_id, 'two')
    assert.deepEqual(call.result.jobs[0].detail, { completed: 2, total: 4 })
    assert.equal(call.result.jobs[0].max_attempts, 8)
    assert.equal(call.result.jobs[0].error, 'Provider unavailable')
    assert.ok(!JSON.stringify(call.body).includes('NEVER-RETURN-THIS'))
    const next = await (
      await f.api(
        '/api/transcriptions?mode=detailed&limit=1&cursor=' +
          encodeURIComponent(call.result.next_cursor),
      )
    ).json()
    assert.equal(next.jobs[0].recording_id, 'one')
    assert.equal(next.next_cursor, null)
    const single = await f.rpc('transcription_status', { id: 'one' })
    assert.equal(single.result.jobs.length, 2)
    assert.equal((await (await f.api('/api/transcriptions?status=retry')).json()).jobs.length, 1)
    assert.equal((await (await f.api('/api/transcriptions?id=no-audio')).json()).jobs.length, 0)
  } finally {
    f.sqlite.close()
  }
})

test('control API/MCP validate inputs and reject anonymous, revoked, worker and cross-origin access', async () => {
  const f = await setup()
  try {
    assert.equal((await f.api('/api/transcriptions', undefined, {})).status, 401)
    assert.equal(
      (await f.rpc('start_detailed_transcription', { id: 'one' }, {})).response.status,
      401,
    )
    assert.equal(
      (
        await f.rpc(
          'transcription_status',
          {},
          { 'X-Uomi-Worker-Secret': f.env.UOMI_WORKER_SECRET },
        )
      ).response.status,
      403,
    )
    assert.equal(
      (
        await f.api('/api/transcriptions', undefined, {
          'X-Uomi-Worker-Secret': f.env.UOMI_WORKER_SECRET,
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await f.rpc(
          'start_detailed_transcription',
          { id: 'one' },
          { 'oai-authenticated-user-id': 'owner', Origin: 'https://evil.test' },
        )
      ).response.status,
      403,
    )
    assert.equal(
      (await f.rpc('start_detailed_transcription', { id: 'no-audio' })).body.result
        .structuredContent.code,
      'audio_unavailable',
    )
    for (const [name, args] of [
      ['start_detailed_transcription', { id: 'missing' }],
      ['start_detailed_transcription', { id: 'one', retry: 'true' }],
      ['transcription_status', { mode: 'bad' }],
      ['transcription_status', { limit: 101 }],
      ['transcription_status', { cursor: 'bad' }],
      ['transcription_status', { id: "x' OR 1=1" }],
    ])
      assert.equal((await f.rpc(name, args)).body.result.isError, true)
    assert.equal((await f.api('/api/transcriptions?id=missing')).status, 404)
    assert.equal((await f.api('/api/transcriptions?mode=bad')).status, 400)
    const alias = await f.api('/api/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'transcription_status', arguments: {} },
    })
    assert.equal(alias.status, 200)
    assert.equal((await alias.json()).result.isError, undefined)
    assert.equal(
      (await f.api('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {})).status,
      401,
    )
    const list = await (await f.api('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()
    const start = list.result.tools.find((t) => t.name === 'start_detailed_transcription')
    assert.equal(start.annotations.readOnlyHint, false)
    assert.equal(
      list.result.tools.find((t) => t.name === 'transcription_status').annotations.readOnlyHint,
      true,
    )
    f.sqlite.prepare('UPDATE client_keys SET revoked=1').run()
    assert.equal((await f.rpc('transcription_status')).response.status, 401)
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM transcription_jobs').get().n, 0)
  } finally {
    f.sqlite.close()
  }
})
