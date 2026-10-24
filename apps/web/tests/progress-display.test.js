import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recordingStart, recordingTitle, recordingDate, japanTime } from '../src/recording-time.ts'
import { stageLabel, progressLines } from '../src/job-progress.ts'

test('recording timestamps use Japan time across UTC day boundaries and replace automatic ISO titles only', () => {
  const t = Date.parse('2026-10-23T23:30:00Z')
  assert.equal(recordingStart(t), '2026/10/24 08:30')
  assert.equal(
    recordingTitle({ title: '2026-10-23T23:30:00.000Z', recorded_at: t }),
    '2026/10/24 08:30',
  )
  assert.equal(recordingTitle({ title: 'Meeting with team', recorded_at: t }), 'Meeting with team')
  assert.equal(recordingTitle({ title: '', recorded_at: t }), '2026/10/24 08:30')
  assert.equal(recordingStart(0), '1970/01/01 09:00')
  assert.equal(recordingStart(null), 'Untimed recording')
  assert.equal(recordingDate(t), '2026年10月24日')
  assert.equal(japanTime(t), '08:30:00')
})
test('progress explains completed intervals, original audio ranges, capacity waits and local retries', () => {
  assert.deepEqual(
    progressLines({
      completed: 4,
      total: 10,
      active: [
        { index: 5, start_ms: 60000, end_ms: 65000, attempt: 2, state: 'retrying' },
        { index: 6, start_ms: 70000, end_ms: 75000, attempt: 1, state: 'waiting' },
      ],
    }),
    [
      '4 / 10 segments complete',
      'Segment 5: 1:00–1:05 · retrying (try 2/3)',
      'Segment 6: 1:10–1:15 · waiting for capacity',
    ],
  )
  assert.deepEqual(progressLines({ analyzed_ms: 60000, duration_ms: 90000 }), [
    'Audio analyzed: 1:00 / 1:30',
  ])
  assert.deepEqual(progressLines({ bytes_received: 1048576, bytes_total: 2097152 }), [
    'Downloaded 1.0 / 2.0 MB',
  ])
  assert.equal(stageLabel('waiting_analysis', 'processing'), 'Waiting for speech analysis')
  assert.equal(stageLabel('completed_no_speech', 'completed'), 'Completed')
})

test('subsecond speech intervals retain their distinct endpoints', () => {
  assert.deepEqual(
    progressLines({
      total: 1,
      active: [{ index: 1, start_ms: 546300, end_ms: 546524, attempt: 1, state: 'transcribing' }],
    }),
    ['0 / 1 segments complete', 'Segment 1: 9:06.3–9:06.524 · transcribing'],
  )
})
