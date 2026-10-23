import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './helpers.js'
import { overlappingRecordingsSql } from '../worker/source-ranges.ts'

test('overlap lookup seeks the upload prefix and preserves range and device boundaries', () => {
  const f = fixture()
  try {
    const insert = f.sqlite.prepare(
      "INSERT INTO recordings(id,edited_at,device,status,url,text) VALUES(?,'','device','Completed','','')",
    )
    for (const id of ['matching', 'touching', 'other-device']) insert.run(id)
    const claim = f.sqlite.prepare(
      'INSERT INTO source_ranges(device,prefix,start,end,recording_id) VALUES(?,?,?,?,(SELECT rid FROM recordings WHERE id=?))',
    )
    claim.run('device', 'packet:', 10, 20, 'matching')
    claim.run('device', 'packet:', 20, 30, 'touching')
    claim.run('other', 'packet:', 10, 20, 'other-device')
    const args = [
      JSON.stringify([
        { prefix: 'packet:', start: 12, end: 20 },
        { prefix: 'packet:', start: 15, end: 18 },
      ]),
      'device',
    ]
    const rows = f.sqlite.prepare(overlappingRecordingsSql).all(...args)
    assert.deepEqual(
      rows.map((row) => row.recording_id),
      ['matching'],
    )
    const plan = f.sqlite.prepare('EXPLAIN QUERY PLAN ' + overlappingRecordingsSql).all(...args)
    assert.ok(
      plan.some((row) => /SEARCH s .*prefix=\?/.test(row.detail)),
      JSON.stringify(plan),
    )
    assert.ok(
      plan.findIndex((row) => /SCAN j /.test(row.detail)) <
        plan.findIndex((row) => /SEARCH s /.test(row.detail)),
    )
  } finally {
    f.sqlite.close()
  }
})
