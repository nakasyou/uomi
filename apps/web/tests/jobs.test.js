import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './helpers.js'
import app from '../worker/app.ts'
import { enqueue, enqueueLongDefault } from '../worker/jobs.ts'
import { cachePage } from '../worker/notion-cache.ts'
const request = (path, data, method = data ? 'POST' : 'GET') =>
  new Request('https://uomi.test' + path, {
    method,
    headers: { 'oai-authenticated-user-id': 'owner', 'Content-Type': 'application/json' },
    ...(method !== 'GET' && data ? { body: JSON.stringify(data) } : {}),
  })
async function call(f, path, data, method) {
  const r = await app.fetch(request(path, data, method), f.env, f.ctx)
  return { status: r.status, ...(await r.json()) }
}
function recording(f, id = 'recording') {
  f.sqlite
    .prepare(
      "INSERT INTO recordings(id,edited_at,device,status,url,text,audio_key,duration_ms,backup_step,primary_owned) VALUES(?,'now','phone','Pending','','','audio/test.ogg',10000,'uncertain',1)",
    )
    .run(id)
}
test('parallel consumers claim exclusive jobs; heartbeats, completion, segments and duplicate receipts are durable without Notion', async () => {
  const f = fixture()
  recording(f)
  await enqueue(f.env, 'recording')
  const claims = await Promise.all([
    call(f, '/api/jobs/claim', { worker_id: 'a' }),
    call(f, '/api/jobs/claim', { worker_id: 'b' }),
  ])
  assert.equal(claims.flatMap((x) => x.jobs).length, 1)
  const job = claims.flatMap((x) => x.jobs)[0]
  assert.equal(job.audio_url, 'https://uomi.test/api/recordings/recording/audio')
  const path = '/api/jobs/' + job.id
  const beat = await call(f, path + '/heartbeat', {
    lease_token: job.lease_token,
    stage: 'transcribing',
    progress: 0.4,
  })
  assert.equal(beat.status, 200)
  const detail = await call(f, '/api/recordings/recording')
  assert.equal(detail.transcription.progress, 0.4)
  assert.equal(detail.transcription.stage, 'transcribing')
  const result = {
    lease_token: job.lease_token,
    text: '学校で話した',
    segments: [{ start_ms: 100, end_ms: 1400, text: '学校で話した', speaker: 'speaker-1' }],
    model: 'test',
  }
  assert.equal((await call(f, path + '/complete', result)).saved, true)
  assert.equal((await call(f, path + '/complete', result)).duplicate, true)
  const row = f.sqlite.prepare('SELECT * FROM recordings').get()
  assert.equal(row.text, result.text)
  assert.equal(row.status, 'Completed')
  assert.equal(JSON.parse(row.transcript_segments)[0].speaker, 'speaker-1')
  assert.equal((await call(f, '/api/recordings?q=' + encodeURIComponent('学校'))).results.length, 1)
  assert.deepEqual((await call(f, '/api/jobs/claim', { worker_id: 'c' })).jobs, [])
  await enqueue(f.env, 'recording')
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM transcription_jobs').get().n, 1)
  f.sqlite.close()
})
test('expired worker cannot overwrite a newer lease or hide its failure; retry waits for available_at', async () => {
  const f = fixture()
  recording(f)
  await enqueue(f.env, 'recording')
  const a = (await call(f, '/api/jobs/claim', { worker_id: 'a' })).jobs[0],
    path = '/api/jobs/' + a.id
  f.sqlite.prepare('UPDATE transcription_jobs SET lease_until=1').run()
  assert.equal(
    (await call(f, path + '/complete', { lease_token: a.lease_token, text: 'stale' })).status,
    409,
  )
  const b = (await call(f, '/api/jobs/claim', { worker_id: 'b' })).jobs[0]
  assert.notEqual(a.lease_token, b.lease_token)
  assert.equal(b.attempt, 2)
  assert.equal((await call(f, path + '/heartbeat', { lease_token: a.lease_token })).status, 409)
  assert.equal(
    (
      await call(f, path + '/fail', {
        lease_token: b.lease_token,
        error: 'Provider HTTP 429 quota exhausted',
        retry_after_seconds: 600,
      })
    ).status,
    'retry',
  )
  assert.deepEqual((await call(f, '/api/jobs/claim', { worker_id: 'c' })).jobs, [])
  const detail = await call(f, '/api/recordings/recording')
  assert.match(detail.transcription.error, /HTTP 429/)
  f.sqlite.prepare('UPDATE transcription_jobs SET available_at=0').run()
  const c = (await call(f, '/api/jobs/claim', { worker_id: 'c' })).jobs[0]
  assert.equal(c.attempt, 3)
  assert.equal(
    (await call(f, path + '/complete', { lease_token: b.lease_token, text: 'late result' })).status,
    409,
  )
  assert.equal(
    (
      await call(f, path + '/fail', {
        lease_token: c.lease_token,
        error: 'Unsupported audio',
        retryable: false,
      })
    ).status,
    'failed',
  )
  assert.equal(
    (await call(f, '/api/recordings/recording/transcription', {})).transcription.status,
    'queued',
  )
  f.sqlite.close()
})
test('detailed jobs preserve standard transcript; malformed segments cannot complete, optional backup does not block edits', async () => {
  const f = fixture()
  recording(f)
  f.sqlite.prepare("UPDATE recordings SET text='Standard text',status='Completed'").run()
  const start = await call(f, '/api/recordings/recording/detailed-transcription', {})
  assert.equal(start.status, 202)
  assert.equal(start.detailed_status, 'Pending')
  await call(f, '/api/recordings/recording/detailed-transcription', {})
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM transcription_jobs').get().n, 1)
  const j = (await call(f, '/api/jobs/claim', { worker_id: 'd' })).jobs[0]
  assert.equal(j.mode, 'detailed')
  const path = '/api/jobs/' + j.id + '/complete'
  assert.equal(
    (
      await call(f, path, {
        lease_token: j.lease_token,
        text: 'Detailed',
        segments: [{ start_ms: -1, end_ms: 10, text: 'bad' }],
      })
    ).status,
    400,
  )
  assert.equal((await call(f, path, { lease_token: j.lease_token, text: 'Detailed' })).saved, true)
  const edited = await call(
    f,
    '/api/recordings/recording',
    { title: 'Changed title', starred: true },
    'PATCH',
  )
  assert.equal(edited.saved, true)
  await Promise.all(f.tasks)
  const row = f.sqlite.prepare('SELECT * FROM recordings').get()
  assert.equal(row.title, 'Changed title')
  assert.equal(row.starred, 1)
  assert.equal(row.text, 'Standard text')
  assert.equal(row.detailed_text, 'Detailed')
  const skipped = await cachePage(f.env, { id: 'recording', archived: true, properties: {} })
  assert.equal(skipped.skipped, 'primary-owned')
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM recordings').get().n, 1)
  f.sqlite.close()
})
test('max attempts terminates an abandoned job and exposes explicit state; invalid claims have request ids', async () => {
  const f = fixture()
  recording(f)
  await enqueue(f.env, 'recording')
  await call(f, '/api/jobs/claim', { worker_id: 'a' })
  f.sqlite.prepare('UPDATE transcription_jobs SET lease_until=1,attempt=8').run()
  assert.deepEqual((await call(f, '/api/jobs/claim', { worker_id: 'b' })).jobs, [])
  const detail = await call(f, '/api/recordings/recording')
  assert.equal(detail.status, 'Failed')
  assert.equal(detail.transcription.status, 'failed')
  assert.match(detail.transcription.error, /maximum attempts/)
  const invalid = await call(f, '/api/jobs/claim', { worker_id: 'b', limit: 99 })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.code, 'invalid_request')
  assert.ok(invalid.request_id)
  f.sqlite.close()
})
test('worker secret permits only job transport and authenticated audio/manifest reads; worker keys cannot issue owner credentials', async () => {
  const f = fixture()
  recording(f)
  await enqueue(f.env, 'recording')
  const secret = 'dedicated-worker-secret-at-least-24-characters'
  f.env.UOMI_WORKER_SECRET = secret
  f.env.UOMI_WEBHOOK_SECRET = 'old-worker-secret-at-least-24-characters'
  const req = (path, method = 'GET', data, credential = secret) =>
    new Request('https://uomi.test' + path, {
      method,
      headers: { 'X-Uomi-Secret': credential },
      ...(method !== 'GET' && data ? { body: JSON.stringify(data) } : {}),
    })
  assert.equal((await app.fetch(req('/api/jobs'), f.env, f.ctx)).status, 200)
  assert.equal(
    (await app.fetch(req('/api/jobs', 'GET', undefined, f.env.UOMI_WEBHOOK_SECRET), f.env, f.ctx))
      .status,
    401,
  )
  for (const [path, method, data] of [
    ['/api/clients', 'GET'],
    ['/api/clients', 'POST', { name: 'escalate' }],
    ['/api/recordings', 'GET'],
    ['/api/recordings/recording', 'PATCH', { title: 'bad' }],
    ['/api/chunks', 'POST', {}],
    ['/api/resync', 'POST', {}],
    ['/api/recordings/recording/detailed-transcription', 'POST', {}],
  ])
    assert.equal((await app.fetch(req(path, method, data), f.env, f.ctx)).status, 403, path)
  const claimed = await app.fetch(
    req('/api/jobs/claim', 'POST', { worker_id: 'service' }),
    f.env,
    f.ctx,
  )
  const j = (await claimed.json()).jobs[0]
  assert.equal(claimed.status, 200)
  assert.equal((await app.fetch(req('/api/recordings/recording/audio'), f.env, f.ctx)).status, 404) // Authorized, object missing
  assert.equal(
    (
      await app.fetch(
        req('/api/jobs/' + j.id + '/complete', 'POST', {
          lease_token: j.lease_token,
          text: 'Worker result',
        }),
        f.env,
        f.ctx,
      )
    ).status,
    200,
  )
  delete f.env.UOMI_WORKER_SECRET
  assert.equal(
    (await app.fetch(req('/api/jobs', 'GET', undefined, f.env.UOMI_WEBHOOK_SECRET), f.env, f.ctx))
      .status,
    200,
  )
  assert.equal(
    (
      await app.fetch(
        req('/api/jobs', 'GET', undefined, 'incorrect-worker-secret-24-characters'),
        f.env,
        f.ctx,
      )
    ).status,
    401,
  )
  f.sqlite.close()
})
test('explicit retry creates jobs for completed legacy text and requeues completed jobs without discarding previous results', async () => {
  const f = fixture()
  recording(f)
  f.sqlite.prepare("UPDATE recordings SET status='Completed',text='Previous result'").run()
  assert.equal(await enqueue(f.env, 'recording'), null)
  const first = await call(f, '/api/recordings/recording/transcription', { retry: true })
  assert.equal(first.transcription.status, 'queued')
  const job = (await call(f, '/api/jobs/claim', { worker_id: 'again' })).jobs[0]
  await call(f, '/api/jobs/' + job.id + '/complete', {
    lease_token: job.lease_token,
    text: 'New result',
  })
  await call(f, '/api/recordings/recording/transcription', {})
  assert.equal(f.sqlite.prepare('SELECT status FROM transcription_jobs').get().status, 'completed')
  await call(f, '/api/recordings/recording/transcription', { retry: true })
  assert.equal(f.sqlite.prepare('SELECT status FROM transcription_jobs').get().status, 'queued')
  assert.equal(f.sqlite.prepare('SELECT text FROM recordings').get().text, 'New result')
  f.sqlite.close()
})
test('worker historical import is bounded and resumable; repeated or archived backups cannot overwrite primary edits', async () => {
  const f = fixture(),
    original = globalThis.fetch
  f.env.UOMI_WORKER_SECRET = 'worker-migration-secret-at-least-24-characters'
  f.env.NOTION_TOKEN = 'notion'
  f.env.NOTION_DATA_SOURCE_ID = 'b'.repeat(32)
  recording(f)
  f.sqlite.prepare("UPDATE recordings SET text='Current primary result',title='Edited title'").run()
  const page = {
    id: 'recording',
    properties: { 'Recording ID': { rich_text: [{ plain_text: 'recording' }] } },
    last_edited_time: '2026-10-23T00:00:00Z',
  }
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/data_sources/') && init.method === 'POST') {
      const query = JSON.parse(init.body)
      assert.equal(query.page_size, 1)
      return Response.json({
        results: [{ ...page, archived: !!query.is_archived }],
        has_more: false,
      })
    }
    return Response.json({ id: f.env.NOTION_DATA_SOURCE_ID })
  }
  const req = (method, data) =>
    new Request('https://uomi.test/api/migrations/notion', {
      method,
      headers: { 'X-Uomi-Secret': f.env.UOMI_WORKER_SECRET },
      ...(method !== 'GET' && data ? { body: JSON.stringify(data) } : {}),
    })
  try {
    let r = await app.fetch(req('GET'), f.env, f.ctx)
    assert.equal((await r.json()).status, 'not_started')
    r = await app.fetch(req('POST', { reset: true }), f.env, f.ctx)
    let data = await r.json()
    assert.equal(data.has_more, true)
    assert.equal(data.updates[0].skipped, 'primary-owned')
    let progress = await (await app.fetch(req('GET'), f.env, f.ctx)).json()
    assert.equal(progress.status, 'paused')
    assert.equal(progress.lease_until, 0)
    f.sqlite.prepare('UPDATE resync_state SET lease_until=? WHERE id=1').run(Date.now() + 60000)
    progress = await (await app.fetch(req('GET'), f.env, f.ctx)).json()
    assert.equal(progress.status, 'running')
    f.sqlite.prepare('UPDATE resync_state SET lease_until=0 WHERE id=1').run()
    r = await app.fetch(req('POST', {}), f.env, f.ctx)
    data = await r.json()
    assert.equal(data.has_more, false)
    const state = await (await app.fetch(req('GET'), f.env, f.ctx)).json()
    assert.equal(state.status, 'completed')
    assert.equal(state.error, null)
    const row = f.sqlite.prepare('SELECT * FROM recordings').get()
    assert.equal(row.text, 'Current primary result')
    assert.equal(row.title, 'Edited title')
    assert.equal(row.audio_key, 'audio/test.ogg')
  } finally {
    globalThis.fetch = original
    f.sqlite.close()
  }
})

test('migration reports an active lease separately from a saved resumable cursor', async () => {
  const f = fixture()
  try {
    f.sqlite
      .prepare(
        "INSERT INTO resync_state(id,cursor,since,started,lease_until) VALUES(1,'{}','1970-01-01T00:00:00.000Z','2026-10-23T00:00:00.000Z',0)",
      )
      .run()
    const read = async () => {
      const r = await app.fetch(
        new Request('https://uomi.test/api/migrations/notion', {
          headers: { 'oai-authenticated-user-id': 'owner' },
        }),
        f.env,
        f.ctx,
      )
      return r.json()
    }
    assert.equal((await read()).status, 'paused')
    f.sqlite.prepare('UPDATE resync_state SET lease_until=? WHERE id=1').run(Date.now() + 30000)
    assert.equal((await read()).status, 'running')
    f.sqlite
      .prepare(
        "UPDATE resync_state SET lease_until=0,last_error='Temporary gateway failure' WHERE id=1",
      )
      .run()
    assert.equal((await read()).status, 'failed')
  } finally {
    f.sqlite.close()
  }
})

test('completion records the evidence for silence separately from empty recognition and legacy results', async () => {
  const f = fixture()
  try {
    for (const [id, outcome, expected] of [
      ['silence', 'no_speech', 'completed_no_speech'],
      ['empty', 'empty', 'completed_empty'],
      ['legacy', undefined, 'completed'],
    ]) {
      recording(f, id)
      await enqueue(f.env, id)
      const job = (await call(f, '/api/jobs/claim', { worker_id: 'outcome' })).jobs[0]
      if (outcome) {
        const invalid = await call(f, '/api/jobs/' + job.id + '/complete', {
          lease_token: job.lease_token,
          text: 'Has text',
          outcome,
        })
        assert.equal(invalid.status, 400)
      }
      const done = await call(f, '/api/jobs/' + job.id + '/complete', {
        lease_token: job.lease_token,
        text: '',
        outcome,
      })
      assert.equal(done.saved, true)
      const detail = await call(f, '/api/recordings/' + id)
      assert.equal(detail.transcription.stage, expected)
      assert.equal(detail.transcription.status, 'completed')
    }
  } finally {
    f.sqlite.close()
  }
})

test('detailed progress persists through heartbeat, status and list reads while rejecting invalid counts', async () => {
  const f = fixture()
  try {
    recording(f)
    await enqueue(f.env, 'recording')
    const job = (await call(f, '/api/jobs/claim', { worker_id: 'progress' })).jobs[0]
    const detail = {
      completed: 3,
      total: 8,
      active: [{ index: 4, start_ms: 2000, end_ms: 4000, attempt: 2, state: 'retrying' }],
    }
    const beat = await call(f, '/api/jobs/' + job.id + '/heartbeat', {
      lease_token: job.lease_token,
      stage: 'transcribing',
      progress: 0.5,
      detail,
    })
    assert.equal(beat.status, 200)
    assert.deepEqual(
      (await call(f, '/api/recordings/recording/status')).transcription.detail,
      detail,
    )
    assert.deepEqual((await call(f, '/api/recordings')).results[0].transcription.detail, detail)
    assert.deepEqual((await call(f, '/api/recordings/recording')).transcription.detail, detail)
    const invalid = await call(f, '/api/jobs/' + job.id + '/heartbeat', {
      lease_token: job.lease_token,
      detail: { completed: 9, total: 8 },
    })
    assert.equal(invalid.status, 400)
  } finally {
    f.sqlite.close()
  }
})

test('long jobs have independent status, durable text-only completion, failure and retry', async () => {
  const f = fixture()
  try {
    recording(f)
    f.sqlite
      .prepare(
        "UPDATE recordings SET status='Completed',text='original',detailed_status='Completed',detailed_text='detailed'",
      )
      .run()
    const start = await call(f, '/api/recordings/recording/long-transcription', {})
    assert.equal(start.status, 202)
    assert.equal(start.long_status, 'Pending')
    assert.equal(start.long_transcription.mode, 'long')
    const claim = (await call(f, '/api/jobs/claim', { worker_id: 'long-worker' })).jobs[0]
    const state = await call(f, '/api/recordings/recording/status')
    assert.equal(state.long_status, 'Processing')
    assert.equal(state.long_transcription.id, claim.id)
    assert.equal(state.status, 'Completed')
    const path = '/api/jobs/' + claim.id
    assert.equal(
      (
        await call(f, path + '/fail', {
          lease_token: claim.lease_token,
          error: 'temporary',
          retryable: false,
        })
      ).status,
      'failed',
    )
    assert.equal((await call(f, '/api/recordings/recording')).long_error, 'temporary')
    await call(f, '/api/recordings/recording/long-transcription', { retry: true })
    const retry = (await call(f, '/api/jobs/claim', { worker_id: 'long-worker' })).jobs[0]
    assert.equal(
      (
        await call(f, path + '/complete', {
          lease_token: retry.lease_token,
          text: 'long',
          segments: [{ start_ms: 0, end_ms: 100, text: 'bad' }],
        })
      ).status,
      400,
    )
    assert.equal(
      (
        await call(f, path + '/complete', {
          lease_token: retry.lease_token,
          text: 'long passage',
          segments: [],
          outcome: 'transcribed',
        })
      ).saved,
      true,
    )
    assert.equal(
      (await call(f, path + '/complete', { lease_token: retry.lease_token, text: 'long passage' }))
        .duplicate,
      true,
    )
    const full = await call(f, '/api/recordings/recording')
    assert.equal(full.long_text, 'long passage')
    assert.equal(full.long_status, 'Completed')
    assert.equal(full.long_error, '')
    assert.equal(full.text, 'original')
    assert.equal(full.detailed_text, 'detailed')
    const get = await call(f, '/api/recordings/recording/long-transcription')
    assert.equal(get.long_transcription.status, 'completed')
    assert.equal(get.long_text, 'long passage')
  } finally {
    f.sqlite.close()
  }
})

test('automatic long enqueue is idempotent and preserves completed imported long text', async () => {
  const f = fixture()
  try {
    recording(f)
    await enqueueLongDefault(f.env, 'recording')
    await enqueueLongDefault(f.env, 'recording')
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM transcription_jobs').get().n, 1)
    f.sqlite.prepare('DELETE FROM transcription_jobs').run()
    f.sqlite
      .prepare("UPDATE recordings SET long_status='Completed',long_text='imported long'")
      .run()
    await enqueueLongDefault(f.env, 'recording')
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM transcription_jobs').get().n, 0)
    assert.equal(
      f.sqlite.prepare('SELECT long_text FROM recordings').get().long_text,
      'imported long',
    )
  } finally {
    f.sqlite.close()
  }
})

test('provider queues claim independently, retain FIFO within each lane and reclaim only their own leases', async () => {
  const f = fixture()
  try {
    for (const id of ['a', 'b', 'c']) recording(f, id)
    await enqueue(f.env, 'a', 'standard')
    await enqueue(f.env, 'b', 'long')
    await enqueue(f.env, 'c', 'detailed')
    f.sqlite
      .prepare(
        "UPDATE transcription_jobs SET created_at=CASE mode WHEN 'standard' THEN 1 WHEN 'long' THEN 2 ELSE 3 END",
      )
      .run()
    const codex = await call(f, '/api/jobs/claim', { worker_id: 'codex', queue: 'codex', limit: 2 })
    assert.deepEqual(
      codex.jobs.map((job) => job.mode),
      ['detailed'],
    )
    const chrome = await call(f, '/api/jobs/claim', {
      worker_id: 'chrome',
      queue: 'chrome',
      limit: 1,
    })
    assert.deepEqual(
      chrome.jobs.map((job) => job.mode),
      ['standard'],
    )
    f.sqlite.prepare("UPDATE transcription_jobs SET lease_until=1 WHERE mode='detailed'").run()
    const next = await call(f, '/api/jobs/claim', {
      worker_id: 'chrome',
      queue: 'chrome',
      limit: 2,
    })
    assert.deepEqual(
      next.jobs.map((job) => job.mode),
      ['long'],
    )
    assert.equal(
      (await call(f, '/api/jobs/claim', { worker_id: 'codex', queue: 'codex' })).jobs[0].attempt,
      2,
    )
    assert.equal(
      (await call(f, '/api/jobs/claim', { worker_id: 'bad', queue: 'fluidaudio' })).status,
      400,
    )
  } finally {
    f.sqlite.close()
  }
})
