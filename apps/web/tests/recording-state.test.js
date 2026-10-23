import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeRecording, mergeRecordingPage } from '../src/recording-state.ts'
test('a late recording response cannot undo a confirmed edit or cutover refresh', () => {
  const edited = {
    id: 'recording',
    title: 'New title',
    starred: true,
    revision: 3,
    updated_at: '2026-10-23T12:00:00Z',
  }
  const late = mergeRecording(edited, {
    title: 'Old title',
    starred: false,
    revision: 2,
    updated_at: '2026-10-23T11:00:00Z',
  })
  assert.equal(late, edited)
  assert.equal(
    mergeRecording(edited, {
      title: 'Old snapshot',
      revision: 3,
      updated_at: '2026-10-23T11:00:00Z',
    }),
    edited,
  )
  const progress = mergeRecording(edited, { revision: 3, stage: 'transcribing' })
  assert.equal(progress.title, 'New title')
  assert.equal(progress.stage, 'transcribing')
  assert.equal(mergeRecording(edited, { title: 'Later title', revision: 4 }).title, 'Later title')
})

test('delayed pages retain confirmed edits, respect filtered membership, and merge overlapping pagination', () => {
  const a = { id: 'a', title: 'Confirmed title', revision: 3 }
  const b = { id: 'b', title: 'Other', revision: 1 }
  const late = { id: 'a', title: 'Old title', revision: 2 }
  assert.deepEqual(mergeRecordingPage([a], [late, b]), [a, b])
  assert.deepEqual(mergeRecordingPage([a, b], [b]), [b])
  assert.deepEqual(
    mergeRecordingPage(
      [a, b],
      [{ ...b, revision: 2 }, late, { id: 'c', title: 'New', revision: 1 }],
      true,
    ),
    [a, { ...b, revision: 2 }, { id: 'c', title: 'New', revision: 1 }],
  )
})
