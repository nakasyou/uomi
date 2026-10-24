import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'

test('adding long mode preserves existing job leases, progress and claim indexes', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const directory = new URL('../drizzle/', import.meta.url)
    for (const name of readdirSync(directory)
      .filter((name) => name.endsWith('.sql') && name < '0010')
      .sort())
      db.exec(readFileSync(new URL(name, directory), 'utf8'))
    db.exec(
      "INSERT INTO recordings(id,edited_at,device,status,url,text) VALUES('r','now','phone','Completed','','saved text')",
    )
    db.exec(
      `INSERT INTO transcription_jobs(id,recording_id,mode,status,worker_id,lease_token,lease_until,attempt,created_at,updated_at,progress_detail) VALUES('r:standard','r','standard','processing','mac','token',12345678,3,1,2,'{"completed":2,"total":8}')`,
    )
    const before = db.prepare('SELECT * FROM transcription_jobs').get()
    db.exec(readFileSync(new URL('0010_long_transcription.sql', directory), 'utf8'))
    assert.deepEqual(db.prepare('SELECT * FROM transcription_jobs').get(), before)
    assert.equal(db.prepare('SELECT text FROM recordings').get().text, 'saved text')
    db.exec(
      "INSERT INTO transcription_jobs(id,recording_id,mode,created_at,updated_at) VALUES('r:long','r','long',3,3)",
    )
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((row) => row.name)
    for (const name of ['jobs_claim', 'jobs_recent', 'jobs_due', 'jobs_expired', 'jobs_exhausted'])
      assert.ok(indexes.includes(name))
  } finally {
    db.close()
  }
})
