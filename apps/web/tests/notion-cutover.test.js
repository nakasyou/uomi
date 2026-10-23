import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fixture } from './helpers.js'
import { cachePage } from '../worker/notion-cache.ts'
import app, { backup, pendingBackupsSql, digest } from '../worker/app.ts'
import { oggOpus } from '@uomi/audio'
function baseline(f, id = 'baseline') {
  f.sqlite
    .prepare(
      "INSERT INTO recordings(id,edited_at,device,status,url,text,title,audio_key,audio_sha,manifest_key,primary_owned,notion_edited,backup_page,backup_step,backup_revision) VALUES(?,'old','phone','Completed','','Old cached text','Old cached title','audio/original','old','manifest/original',1,'2026-10-22T00:00:00Z',?,'done',-1)",
    )
    .run(id, 'a'.repeat(32))
  const rid = f.sqlite.prepare('SELECT rid FROM recordings WHERE id=?').get(id).rid
  f.sqlite.prepare("INSERT INTO source_ranges VALUES('phone','old:',0,1,?)").run(rid)
}
async function source() {
  const audio = oggOpus([{ id: 'new:0', data: 'mAE=', durationMs: 20, offsetMs: 0 }]),
    sha = await digest(audio)
  const manifest = {
    schema: 'uomi.notion.v1',
    id: 'baseline',
    deviceId: 'phone',
    capturedAt: null,
    durationMs: 20,
    sha256: sha,
    frameIds: ['new:0'],
    timing: [],
  }
  const files = (name) => ({ files: [{ file: { url: 'https://files.test/' + name } }] })
  const page = {
    id: 'a'.repeat(32),
    last_edited_time: '2026-10-23T00:00:00Z',
    properties: {
      'Recording ID': { rich_text: [{ plain_text: 'baseline' }] },
      Device: { rich_text: [{ plain_text: 'phone' }] },
      Name: { type: 'title', title: [{ plain_text: 'Latest Notion title' }] },
      Status: { select: { name: 'Completed' } },
      Audio: files('audio'),
      Manifest: files('manifest'),
      Transcript: files('transcript'),
    },
  }
  return {
    page,
    fetch: async (url) =>
      String(url).endsWith('/manifest')
        ? Response.json(manifest)
        : String(url).endsWith('/audio')
          ? new Response(audio)
          : Response.json({
              schema: 'uomi.transcript.v1',
              text: 'Latest Notion transcript',
              segments: [
                { start_ms: 0, end_ms: 20, text: 'Latest Notion transcript', speaker: 'speaker-1' },
              ],
            }),
  }
}
test('one cutover refresh replaces untouched historical snapshots, finalizes backup baseline, and preserves new primary edits on subsequent import', async () => {
  const f = fixture(),
    original = globalThis.fetch,
    s = await source()
  baseline(f)
  globalThis.fetch = s.fetch
  try {
    const result = await cachePage(f.env, s.page)
    assert.equal(result.cached, true)
    let row = f.sqlite.prepare('SELECT * FROM recordings').get()
    assert.equal(row.text, 'Latest Notion transcript')
    assert.equal(row.title, 'Latest Notion title')
    const detail = await (
      await app.fetch(
        new Request('https://uomi.test/api/recordings/baseline', {
          headers: { 'oai-authenticated-user-id': 'owner' },
        }),
        f.env,
        f.ctx,
      )
    ).json()
    assert.equal(detail.updated_at, s.page.last_edited_time)
    assert.equal(detail.revision, 0)
    assert.equal(row.notion_import_version, 1)
    assert.equal(row.backup_revision, row.revision)
    assert.equal(JSON.parse(row.transcript_segments)[0].speaker, 'speaker-1')
    assert.equal(f.sqlite.prepare('SELECT prefix FROM source_ranges').get().prefix, 'new:')
    assert.equal(f.sqlite.prepare(pendingBackupsSql).all(Date.now(), Date.now()).length, 0)
    f.sqlite
      .prepare(
        "UPDATE recordings SET text='Edited primary result',title='Edited primary title',revision=revision+1",
      )
      .run()
    assert.equal((await cachePage(f.env, s.page)).skipped, 'primary-owned')
    row = f.sqlite.prepare('SELECT * FROM recordings').get()
    assert.equal(row.text, 'Edited primary result')
    assert.equal(row.title, 'Edited primary title')
    assert.equal(f.sqlite.prepare(pendingBackupsSql).all(Date.now(), Date.now()).length, 1)
  } finally {
    globalThis.fetch = original
    f.sqlite.close()
  }
})
test('primary edits committed while source fetch is in flight fence every import metadata/segments/source/finalization write', async () => {
  const f = fixture(),
    original = globalThis.fetch,
    s = await source()
  baseline(f)
  let edited = false
  globalThis.fetch = async (url, init) => {
    if (!edited) {
      edited = true
      f.sqlite
        .prepare(
          'UPDATE recordings SET text=\'Concurrent completed result\',title=\'Concurrent title\',revision=1,transcript_segments=\'[{"start_ms":1,"end_ms":2,"text":"primary"}]\',detailed_text=\'Primary detailed\',detailed_segments=\'[{"start_ms":1,"end_ms":2,"text":"detail"}]\' WHERE id=\'baseline\'',
        )
        .run()
    }
    return s.fetch(url, init)
  }
  try {
    await cachePage(f.env, s.page)
    const row = f.sqlite.prepare('SELECT * FROM recordings').get()
    assert.equal(row.text, 'Concurrent completed result')
    assert.equal(row.title, 'Concurrent title')
    assert.equal(row.detailed_text, 'Primary detailed')
    assert.equal(JSON.parse(row.transcript_segments)[0].text, 'primary')
    assert.equal(JSON.parse(row.detailed_segments)[0].text, 'detail')
    assert.equal(row.audio_key, 'audio/original')
    assert.equal(row.manifest_key, 'manifest/original')
    assert.equal(row.notion_import_version, 0)
    assert.equal(row.backup_revision, -1)
    assert.equal(f.sqlite.prepare('SELECT prefix FROM source_ranges').get().prefix, 'old:')
  } finally {
    globalThis.fetch = original
    f.sqlite.close()
  }
})
test('untouched cached baselines never trigger source backup, and forward cutover migration cancels stale baseline leases without changing new uploads or edits', async () => {
  const f = fixture(),
    original = globalThis.fetch
  baseline(f)
  f.sqlite
    .prepare(
      "UPDATE recordings SET backup_step='page',backup_lease='old-token',backup_until=9999999999999,backup_error='old error'",
    )
    .run()
  Object.assign(f.env, { NOTION_TOKEN: 'token', NOTION_DATA_SOURCE_ID: 'b'.repeat(32) })
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    throw Error('No backup write allowed')
  }
  try {
    await backup(f.env, 'baseline')
    assert.equal(requests, 0)
    assert.equal(f.sqlite.prepare(pendingBackupsSql).all(99999999999999, 99999999999999).length, 0)
    // Reapply the UPDATE portion against a populated pre-cutover state: applied migrations remain immutable.
    const migration = readFileSync(
      new URL('../drizzle/0007_notion_cutover.sql', import.meta.url),
      'utf8',
    )
    const reset = migration.split('--> statement-breakpoint')[1]
    f.sqlite
      .prepare(
        "INSERT INTO recordings(id,edited_at,device,status,url,text,primary_owned,notion_edited,revision,backup_revision) VALUES('edited','now','phone','Completed','','Primary',1,'old',1,-1),('upload','now','phone','Pending','','',1,NULL,0,-1)",
      )
      .run()
    f.sqlite.exec(reset)
    const row = f.sqlite.prepare("SELECT * FROM recordings WHERE id='baseline'").get()
    assert.equal(row.backup_revision, 0)
    assert.equal(row.backup_lease, null)
    assert.equal(row.backup_until, 0)
    assert.equal(row.backup_error, null)
    assert.deepEqual(
      f.sqlite
        .prepare("SELECT id,backup_revision FROM recordings WHERE id!='baseline' ORDER BY id")
        .all()
        .map((r) => [r.id, r.backup_revision]),
      [
        ['edited', -1],
        ['upload', -1],
      ],
    )
  } finally {
    globalThis.fetch = original
    f.sqlite.close()
  }
})
test('missing historical audio can hydrate after source upload completes, without replacing finalized baseline metadata', async () => {
  const f = fixture(),
    original = globalThis.fetch,
    s = await source()
  const missing = {
    ...s.page,
    properties: {
      ...s.page.properties,
      Audio: undefined,
      Manifest: undefined,
      Transcript: undefined,
    },
  }
  globalThis.fetch = s.fetch
  try {
    assert.equal((await cachePage(f.env, missing)).warning, 'missing_audio')
    const before = f.sqlite.prepare('SELECT * FROM recordings').get()
    assert.equal(before.audio_key, null)
    assert.equal(before.notion_import_version, 1)
    const result = await cachePage(f.env, s.page)
    assert.equal(result.hydrated, true)
    assert.equal(result.audio_imported, true)
    const after = f.sqlite.prepare('SELECT * FROM recordings').get()
    assert.ok(after.audio_key)
    assert.ok(after.manifest_key)
    for (const key of [
      'title',
      'text',
      'detailed_text',
      'transcript_segments',
      'detailed_segments',
      'revision',
      'notion_import_version',
      'edited_at',
      'backup_revision',
    ])
      assert.equal(after[key], before[key], key)
    assert.equal(f.sqlite.prepare('SELECT prefix FROM source_ranges').get().prefix, 'new:')
  } finally {
    globalThis.fetch = original
    f.sqlite.close()
  }
})
test('missing-audio hydration preserves concurrent primary edits/results and replaces only absent files and source claims', async () => {
  const f = fixture(),
    original = globalThis.fetch,
    s = await source()
  baseline(f)
  f.sqlite
    .prepare(
      'UPDATE recordings SET audio_key=NULL,audio_sha=NULL,manifest_key=NULL,notion_import_version=1,revision=2,title=\'Primary title\',text=\'Primary standard\',detailed_text=\'Primary detail\',transcript_segments=\'[{"start_ms":0,"end_ms":20,"text":"Primary standard"}]\',detailed_segments=\'[{"start_ms":0,"end_ms":20,"text":"Primary detail"}]\'',
    )
    .run()
  let edited = false
  globalThis.fetch = async (url, init) => {
    if (!edited) {
      edited = true
      f.sqlite
        .prepare(
          "UPDATE recordings SET title='Edited during download',text='New primary text',revision=3",
        )
        .run()
    }
    return s.fetch(url, init)
  }
  try {
    const result = await cachePage(f.env, s.page)
    assert.equal(result.hydrated, true)
    const row = f.sqlite.prepare('SELECT * FROM recordings').get()
    assert.equal(row.title, 'Edited during download')
    assert.equal(row.text, 'New primary text')
    assert.equal(row.revision, 3)
    assert.equal(row.detailed_text, 'Primary detail')
    assert.equal(JSON.parse(row.transcript_segments)[0].text, 'Primary standard')
    assert.equal(JSON.parse(row.detailed_segments)[0].text, 'Primary detail')
    assert.equal(row.notion_import_version, 1)
    assert.equal(row.edited_at, 'old')
    assert.equal(row.backup_revision, -1)
    assert.ok(row.audio_key)
    assert.equal(f.sqlite.prepare('SELECT prefix FROM source_ranges').get().prefix, 'new:')
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM transcription_jobs').get().n, 0)
  } finally {
    globalThis.fetch = original
    f.sqlite.close()
  }
})
test('concurrent winner makes late hydration a no-op; archived or still incomplete source does not claim imported audio', async () => {
  const f = fixture(),
    original = globalThis.fetch,
    s = await source()
  baseline(f)
  f.sqlite.prepare('UPDATE recordings SET audio_key=NULL,notion_import_version=1').run()
  try {
    assert.equal((await cachePage(f.env, { ...s.page, archived: true })).warning, 'missing_audio')
    const missing = { ...s.page, properties: { ...s.page.properties, Manifest: undefined } }
    assert.equal((await cachePage(f.env, missing)).audio_imported, false)
    let won = false
    globalThis.fetch = async (url, init) => {
      if (!won) {
        won = true
        f.sqlite
          .prepare("UPDATE recordings SET audio_key='audio/winner',manifest_key='manifest/winner'")
          .run()
      }
      return s.fetch(url, init)
    }
    const result = await cachePage(f.env, s.page)
    assert.equal(result.hydrated, false)
    assert.equal(result.skipped, 'audio-already-present')
    const row = f.sqlite.prepare('SELECT * FROM recordings').get()
    assert.equal(row.audio_key, 'audio/winner')
    assert.equal(row.manifest_key, 'manifest/winner')
    assert.equal(f.sqlite.prepare('SELECT prefix FROM source_ranges').get().prefix, 'old:')
  } finally {
    globalThis.fetch = original
    f.sqlite.close()
  }
})
test('hydration source conflict rolls back its own claims and leaves primary metadata/audio unchanged', async () => {
  const f = fixture(),
    original = globalThis.fetch,
    s = await source()
  baseline(f)
  f.sqlite.prepare('UPDATE recordings SET audio_key=NULL,notion_import_version=1').run()
  f.sqlite
    .prepare(
      "INSERT INTO recordings(id,edited_at,device,status,url,text) VALUES('other','now','phone','Completed','','')",
    )
    .run()
  const rid = f.sqlite.prepare("SELECT rid FROM recordings WHERE id='other'").get().rid
  f.sqlite.prepare("INSERT INTO source_ranges VALUES('phone','new:',0,1,?)").run(rid)
  globalThis.fetch = s.fetch
  try {
    await assert.rejects(() => cachePage(f.env, s.page), /Source audio overlaps/)
    const row = f.sqlite.prepare("SELECT * FROM recordings WHERE id='baseline'").get()
    assert.equal(row.audio_key, null)
    assert.equal(row.title, 'Old cached title')
    assert.equal(row.text, 'Old cached text')
    assert.deepEqual(
      f.sqlite
        .prepare('SELECT prefix FROM source_ranges ORDER BY prefix')
        .all()
        .map((r) => r.prefix),
      ['new:', 'old:'],
    )
  } finally {
    globalThis.fetch = original
    f.sqlite.close()
  }
})
