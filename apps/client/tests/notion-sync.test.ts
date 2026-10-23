import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconciliationQueries } from '../src/core/notion-sync'
import type { RecordIndex } from '../src/core/catalog'

const record = (deviceId: string, capturedAt: string | null, durationMs = 1000) =>
  ({ deviceId, capturedAt, durationMs }) as RecordIndex

test('reconciliation separates devices and distant recordings, merging expanded overlapping windows', () => {
  const start = Date.parse('2026-01-01T00:00:00Z')
  assert.deepEqual(
    reconciliationQueries([
      record('a', '2026-01-03T00:00:00Z'),
      record('a', '2026-01-01T00:10:00Z'),
      record('a', '2026-01-01T00:00:00Z'),
      record('b', '2026-01-02T00:00:00Z'),
    ]),
    [
      { devices: ['a'], from: start, until: start + 601000 },
      { devices: ['a'], from: start + 2 * 86400000, until: start + 2 * 86400000 + 1000 },
      { devices: ['b'], from: start + 86400000, until: start + 86400000 + 1000 },
    ],
  )
})

test('unknown clocks keep the entire device history eligible', () => {
  assert.deepEqual(
    reconciliationQueries([record('a', '2026-01-01T00:00:00Z'), record('a', null)]),
    [{ devices: ['a'] }],
  )
  assert.deepEqual(reconciliationQueries([]), [])
})
