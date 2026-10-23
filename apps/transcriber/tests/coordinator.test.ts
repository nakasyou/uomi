import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { NotionStore, type AudioManifest } from '@uomi/notion'
import { FakeNotion, SOURCE } from '../../../packages/notion/testing/fake'
import { ReservationCoordinator } from '../src/coordinator'
const manifest = (ids: string[]): AudioManifest & { source: string } => ({
  schema: 'uomi.notion.v1',
  source: SOURCE,
  id: createHash('sha256').update(JSON.stringify(ids)).digest('hex'),
  deviceId: 'omi',
  capturedAt: null,
  durationMs: 20 * ids.length,
  sha256: 'a'.repeat(64),
  frameIds: ids,
  timing: [],
})
test('concurrent clients reserve exactly one page and conflicting frame ranges cannot create another', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'uomi-coordinator-'))
  const fake = new FakeNotion()
  const store = new NotionStore(fake.transport, SOURCE)
  const coordinator = new ReservationCoordinator(store, dir)
  try {
    const request = manifest(['frame-1', 'frame-2'])
    const [one, two] = await Promise.all([
      coordinator.reserve(request),
      coordinator.reserve(request),
    ])
    expect(one.pageId).toBe(two.pageId)
    expect(fake.pages.size).toBe(1)
    expect(fake.requests.filter((r) => r.path.endsWith('/query'))).toHaveLength(1)
    await expect(coordinator.reserve(manifest(['frame-2', 'frame-3']))).rejects.toThrow(
      'overlapping',
    )
    expect(fake.pages.size).toBe(1)
    await coordinator.close()
    const restarted = new ReservationCoordinator(store, dir)
    expect(await restarted.reserve(request)).toEqual(one)
    await restarted.close()
  } finally {
    await coordinator.close()
    await rm(dir, { recursive: true, force: true })
  }
})
test('a lost create response is recovered from Notion without creating a duplicate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'uomi-coordinator-'))
  const fake = new FakeNotion()
  let lose = true
  const store = new NotionStore(async (request) => {
    const result = await fake.transport(request)
    if (request.path === '/pages' && lose) {
      lose = false
      throw Error('connection interrupted after creation')
    }
    return result
  }, SOURCE)
  const coordinator = new ReservationCoordinator(store, dir)
  try {
    const request = manifest(['only-frame'])
    await expect(coordinator.reserve(request)).rejects.toThrow('interrupted')
    const resumed = await coordinator.reserve(request)
    expect(fake.pages.has(resumed.pageId)).toBe(true)
    expect(fake.pages.size).toBe(1)
  } finally {
    await coordinator.close()
    await rm(dir, { recursive: true, force: true })
  }
})
