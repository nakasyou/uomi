import { test } from 'node:test'
import assert from 'node:assert/strict'
import { syncProgressText } from '../src/core/progress'
test('preparation progress uses real units and unknown totals never fabricate percentages', () => {
  const text = syncProgressText({
    stage: 'check',
    completed: 12,
    total: 35,
    unit: 'pages',
    detail: 'Checking matching audio manifests',
  })
  assert.match(text, /12 \/ 35 pages · 34%/)
  const unknown = syncProgressText({
    stage: 'refresh',
    completed: 100,
    total: 0,
    unit: 'pages',
    detail: 'Reading changed Notion recordings',
  })
  assert.match(unknown, /100 pages processed/)
  assert.ok(!unknown.includes('%'))
  assert.match(
    syncProgressText({
      stage: 'prepare',
      completed: 50,
      total: 100,
      unit: 'recordings',
      detail: 'Planning audio chunks',
      plannedChunks: 3,
    }),
    /3 chunks planned/,
  )
})
