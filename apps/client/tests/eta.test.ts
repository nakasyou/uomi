import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SyncEta, etaLabel } from '../src/core/eta'
import type { SyncProgress } from '../src/core/types'
const progress = (completed: number): SyncProgress => ({ stage: 'import', completed, total: 100 })
test('ETA learns observed throughput, includes stalls, and resets on stage/restart', () => {
  const eta = new SyncEta()
  assert.equal(eta.remaining(progress(10), 0), null)
  assert.equal(eta.remaining(progress(20), 1000), null)
  assert.equal(eta.remaining(progress(30), 10000), 35000)
  assert.equal(eta.remaining(progress(30), 20000), 70000)
  assert.equal(eta.remaining(progress(0), 21000), null)
  assert.equal(eta.remaining({ ...progress(20), stage: 'upload' }, 30000), null)
  assert.equal(eta.remaining(progress(100), 40000), 0)
})
test('upload ETA follows sent chunks independently of save confirmation and unknown totals never fabricate an estimate', () => {
  const eta = new SyncEta()
  const p: SyncProgress = {
    stage: 'upload',
    total: 100,
    completed: 90,
    chunksTotal: 10,
    chunksSubmitted: 0,
  }
  assert.equal(eta.remaining(p, 0), null)
  assert.equal(eta.remaining({ ...p, completed: 100 }, 10000), null)
  assert.equal(eta.remaining({ ...p, chunksSubmitted: 2 }, 20000), 80000)
  assert.equal(eta.remaining(null, 21000), null)
  assert.equal(eta.remaining({ ...progress(10), total: 0 }, 22000), null)
  assert.equal(etaLabel(null), 'Estimating…')
  assert.equal(etaLabel(80000), 'About 2m remaining')
  assert.equal(etaLabel(3660000), 'About 1h 1m remaining')
})
