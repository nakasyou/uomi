import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fixture } from './helpers.js'
import { enqueue, jobsApi } from '../worker/jobs.ts'

test('requested transcript reset clears both modes and search, fences old leases and preserves source identity', async () => {
  const f = fixture()
  try {
    f.sqlite
      .exec(`INSERT INTO recordings(id,edited_at,device,status,url,text,audio_key,audio_sha,manifest_key,duration_ms,title,starred,search_text,search_version,detailed_text,detailed_segments,transcript_segments,detailed_status)
      VALUES('one','now','device','Completed','','secret transcript','audio/one','hash','manifest/one',10000,'Keep title',1,'secret transcript',1,'detailed secret','[{"start_ms":0}]','[{"start_ms":0}]','Completed'),
      ('two','now','device','Failed','','old','audio/two','hash2','manifest/two',10000,'Other',0,'old',1,'','','','Failed');`)
    await enqueue(f.env, 'one', 'standard', true)
    await enqueue(f.env, 'one', 'detailed', true)
    const claimed = await jobsApi(
      new Request('https://uomi.test/api/jobs/claim', { method: 'POST' }),
      f.env,
      { worker_id: 'old-worker', limit: 2 },
    )
    const before = f.sqlite
      .prepare('SELECT audio_key,audio_sha,manifest_key,title,starred FROM recordings WHERE id=?')
      .get('one')
    f.sqlite.exec(
      readFileSync(new URL('../drizzle/0008_reset_transcripts.sql', import.meta.url), 'utf8'),
    )
    for (const r of f.sqlite.prepare('SELECT * FROM recordings').all()) {
      assert.equal(r.text, '')
      assert.equal(r.detailed_text, '')
      assert.equal(r.search_text, '')
      assert.equal(r.transcript_segments, '[]')
      assert.equal(r.detailed_segments, '[]')
      assert.equal(r.status, 'Pending')
      assert.equal(r.detailed_status, 'Pending')
    }
    assert.deepEqual(
      f.sqlite
        .prepare('SELECT audio_key,audio_sha,manifest_key,title,starred FROM recordings WHERE id=?')
        .get('one'),
      before,
    )
    assert.equal(
      f.sqlite
        .prepare("SELECT count(*) AS n FROM transcripts WHERE transcripts MATCH 'sec'")
        .get().n,
      0,
    )
    const jobs = f.sqlite.prepare('SELECT * FROM transcription_jobs').all()
    assert.equal(jobs.length, 3)
    for (const j of jobs) {
      assert.equal(j.status, 'queued')
      assert.equal(j.attempt, 0)
      assert.equal(j.lease_token, null)
      assert.equal(j.progress, 0)
      assert.equal(j.error, null)
    }
    for (const old of claimed.jobs) {
      await assert.rejects(
        jobsApi(
          new Request('https://uomi.test/api/jobs/' + encodeURIComponent(old.id) + '/complete', {
            method: 'POST',
          }),
          f.env,
          { lease_token: old.lease_token, text: 'Old result' },
        ),
        /lease was replaced/,
      )
    }
  } finally {
    f.sqlite.close()
  }
})
