import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { FakeNotion, SOURCE } from '../../../packages/notion/testing/fake'
import { Engine } from '../src/core/engine'
import { defaults, type Port, type Recording } from '../src/core/types'
function setup() {
  const data = new Map<string, string>()
  const fake = new FakeNotion()
  const record: Recording = {
    key: 'record:test',
    deviceId: 'omi',
    ringId: null,
    sequence: '1',
    capturedAt: '2026-01-01T00:00:00Z',
    timestampRaw: 1767225600,
    timing: 'device-utc',
    frames: [{ id: 'stable-frame', data: 'mAE=', durationMs: 20, offsetMs: 0 }],
    uploaded: 1,
    bytes: 2,
    receivedAt: '2026-01-01T00:00:00Z',
  }
  data.set(record.key, JSON.stringify(record))
  data.set(
    'settings',
    JSON.stringify({
      ...defaults,
      notionSource: SOURCE,
      transcriberEndpoint: 'https://mac.example/webhook',
    }),
  )
  let notified = 0
  const port: Port = {
    get: async (k) => data.get(k) ?? null,
    put: async (k, v) => {
      data.set(k, v)
    },
    list: async (prefix) => [...data.keys()].filter((k) => k.startsWith(prefix)),
    remove: async (k) => {
      data.delete(k)
    },
    secret: async () => 'token',
    hash: async (b) => createHash('sha256').update(Buffer.from(b, 'base64')).digest('hex'),
    scan: async () => [],
    connect: async () => {},
    disconnect: async () => {},
    read: async () => '',
    write: async () => {},
    subscribe: async () => async () => {},
    wifi: async () => true,
    schedule: async () => {},
    post: async () => {
      throw Error('Legacy webhook must not run')
    },
    notion: fake.transport,
    notionFile: fake.attachment,
    notifyTranscriber: async () => {
      notified++
      throw Error('offline')
    },
  }
  return { data, fake, port, engine: new Engine(port), record, notifications: () => notified }
}
test('legacy webhook acknowledgements do not claim Notion sync; offline transcriber retains successful Notion save and local audio', async () => {
  const f = setup()
  await f.engine.init()
  assert.equal(f.engine.getSnapshot().recordings[0].uploaded, 0)
  await f.engine.sync()
  assert.equal(f.engine.getSnapshot().error, null)
  assert.equal(f.engine.getSnapshot().recordings[0].uploaded, 1)
  assert.ok(f.data.has(f.record.key))
  assert.equal(f.notifications(), 1)
  assert.match(f.engine.getSnapshot().remoteRecordings[0].notificationError!, /Saved in Notion/)
  const saved = JSON.parse(f.data.get(f.record.key)!)
  assert.deepEqual(saved.frames, f.record.frames)
  await f.engine.sync()
  assert.equal(f.fake.pages.size, 1)
  f.engine.dispose()
})
test('failed Notion attachment never acknowledges or deletes local frames', async () => {
  const f = setup()
  f.fake.failAttach = true
  await f.engine.init()
  await f.engine.sync()
  assert.equal(f.engine.getSnapshot().recordings[0].uploaded, 0)
  assert.ok(f.engine.getSnapshot().error)
  assert.ok(f.data.has(f.record.key))
  assert.equal(f.notifications(), 0)
  f.fake.failAttach = false
  await f.engine.sync()
  assert.equal(f.fake.pages.size, 1)
  assert.equal(f.engine.getSnapshot().recordings[0].uploaded, 1)
  f.engine.dispose()
})
test('another client’s differently sized chunks reconcile by frame ID without re-uploading local audio', async () => {
  const { NotionStore } = await import('@uomi/notion')
  const f = setup()
  const frames = [f.record.frames[0], { ...f.record.frames[0], id: 'second-frame', offsetMs: 20 }]
  f.data.set(f.record.key, JSON.stringify({ ...f.record, frames, uploaded: 0 }))
  const store = new NotionStore(f.fake.transport, SOURCE)
  for (const frame of frames) {
    await store.saveAudio(
      {
        schema: 'uomi.notion.v1',
        id: `other-client-${frame.id}`,
        deviceId: 'omi',
        capturedAt: null,
        durationMs: 20,
        sha256: 'a'.repeat(64),
        frameIds: [frame.id],
        timing: [],
      },
      new Uint8Array([1]),
    )
  }
  const before = f.fake.files.size
  await f.engine.init()
  await f.engine.sync()
  assert.equal(f.engine.getSnapshot().error, null)
  assert.equal(f.engine.getSnapshot().recordings[0].uploaded, 2)
  assert.equal(f.fake.files.size, before)
  assert.deepEqual(JSON.parse(f.data.get(f.record.key)!).frames, frames)
  assert.equal(f.engine.getSnapshot().remoteRecordings.length, 2)
  f.engine.dispose()
})
test('explicit Notion sync uploads local audio and refreshes transcripts without touching a paired Omi', async () => {
  const f = setup()
  const settings = JSON.parse(f.data.get('settings')!)
  settings.deviceAddress = 'AA:BB:CC:DD:EE:FF'
  f.data.set('settings', JSON.stringify(settings))
  let bluetoothCalls = 0
  const forbidden = async (): Promise<never> => {
    bluetoothCalls++
    throw Error('Notion sync must not use Bluetooth')
  }
  f.port.connect = forbidden
  f.port.disconnect = forbidden
  f.port.read = forbidden
  f.port.write = forbidden
  f.port.subscribe = forbidden
  await f.engine.init()
  await f.engine.syncNotion()
  assert.equal(bluetoothCalls, 0)
  assert.equal(f.engine.getSnapshot().error, null)
  assert.equal(f.engine.getSnapshot().recordings[0].uploaded, 1)
  assert.equal(f.engine.getSnapshot().remoteRecordings.length, 1)
  assert.ok(f.engine.getSnapshot().lastSync)
  assert.equal(f.engine.getSnapshot().lastDeviceSync, null)
  assert.ok(f.data.has(f.record.key))
  f.engine.dispose()
})
test('explicit Notion sync initializes an empty destination even with no local recordings', async () => {
  const f = setup()
  f.data.delete(f.record.key)
  await f.engine.init()
  await f.engine.syncNotion()
  assert.equal(f.engine.getSnapshot().error, null)
  assert.ok(f.fake.requests.some((r) => r.path.startsWith('/data_sources/')))
  assert.ok(f.engine.getSnapshot().lastSync)
  f.engine.dispose()
})

test('Notion sync publishes preparation, file upload, durable chunk completion and refresh progress', async () => {
  const f = setup()
  await f.engine.init()
  const progress: NonNullable<ReturnType<Engine['getSnapshot']>['progress']>[] = []
  f.engine.subscribe(() => {
    const value = f.engine.getSnapshot().progress
    if (value) progress.push({ ...value })
  })
  await f.engine.syncNotion()
  assert.equal(f.engine.getSnapshot().error, null)
  assert.ok(progress.some((p) => p.stage === 'prepare' && p.detail?.includes('configuration')))
  assert.ok(progress.some((p) => p.stage === 'check'))
  for (const detail of [
    'Uploading audio',
    'Uploading audio metadata',
    'Attaching files to Notion',
  ]) {
    const event = progress.find((p) => p.detail === detail)
    assert.ok(event)
    assert.equal(event.completed, 0)
    assert.equal(event.chunksCompleted, 0)
  }
  const complete = progress.find((p) => p.stage === 'upload' && p.chunksCompleted === 1)
  assert.ok(complete)
  assert.equal(complete.completed, complete.total)
  assert.ok(progress.some((p) => p.stage === 'refresh' && p.total === 1))
  assert.equal(f.engine.getSnapshot().checkingNotion, false)
  assert.equal(f.engine.getSnapshot().progress, null)
  f.engine.dispose()
})

test('failed file attachment never reports a completed upload chunk', async () => {
  const f = setup()
  f.fake.failAttach = true
  await f.engine.init()
  const completedChunks: number[] = []
  f.engine.subscribe(() => {
    const progress = f.engine.getSnapshot().progress
    if (progress?.stage === 'upload') completedChunks.push(progress.chunksCompleted ?? 0)
  })
  await f.engine.syncNotion()
  assert.ok(f.engine.getSnapshot().error)
  assert.ok(completedChunks.length > 0)
  assert.ok(completedChunks.every((n) => n === 0))
  f.engine.dispose()
})

test('interrupted Uploading pages resume their exact chunk after restart and reuse valid uploaded files', async () => {
  const f = setup()
  const frames = Array.from({ length: 100 }, (_, i) => ({
    ...f.record.frames[0],
    id: `frame-${i}`,
    offsetMs: i * 20,
  }))
  f.data.set(f.record.key, JSON.stringify({ ...f.record, frames, uploaded: 0 }))
  f.fake.failAttach = true
  await f.engine.init()
  await f.engine.syncNotion()
  assert.ok(f.engine.getSnapshot().error)
  const pageId = [...f.fake.pages.keys()][0]
  assert.equal(f.fake.pages.get(pageId).properties.Status.select.name, 'Uploading')
  assert.equal(f.fake.files.size, 2)
  assert.ok([...f.data.keys()].some((key) => key.startsWith('notion:job:')))
  f.engine.dispose()
  const settings = JSON.parse(f.data.get('settings')!)
  settings.segmentSeconds = 1
  f.data.set('settings', JSON.stringify(settings))
  f.fake.failAttach = false
  const restarted = new Engine(f.port)
  await restarted.init()
  await restarted.syncNotion()
  assert.equal(restarted.getSnapshot().error, null)
  assert.equal(f.fake.pages.size, 1)
  assert.equal(f.fake.files.size, 2)
  assert.equal(f.fake.pages.get(pageId).properties.Status.select.name, 'Pending')
  assert.equal(restarted.getSnapshot().recordings[0].uploaded, 100)
  assert.deepEqual(JSON.parse(f.data.get(f.record.key)!).frames, frames)
  assert.ok(![...f.data.keys()].some((key) => key.startsWith('notion:job:')))
  restarted.dispose()
})

test('expired upload checkpoints resend files into the existing page', async () => {
  const f = setup()
  f.fake.failAttach = true
  await f.engine.init()
  await f.engine.syncNotion()
  f.fake.files.clear()
  f.fake.failAttach = false
  await f.engine.syncNotion()
  assert.equal(f.engine.getSnapshot().error, null)
  assert.equal(f.fake.pages.size, 1)
  assert.equal(f.fake.files.size, 2)
  assert.equal(f.fake.requests.filter((r) => r.path === '/file_uploads').length, 4)
  f.engine.dispose()
})

test('legacy Uploading pages without a checkpoint reuse their page and existing audio attachment', async () => {
  const f = setup()
  f.fake.failAttach = true
  await f.engine.init()
  await f.engine.syncNotion()
  const page = [...f.fake.pages.values()][0]
  const audioId = [...f.fake.files.keys()][0]
  page.properties.Audio = {
    files: [
      {
        name: 'original.ogg',
        file: { url: `https://files.example/${audioId}` },
        file_upload: { id: audioId },
      },
    ],
  }
  const audio = structuredClone(page.properties.Audio)
  for (const key of f.data.keys()) if (key.startsWith('notion:job:')) f.data.delete(key)
  f.fake.failAttach = false
  const before = f.fake.files.size
  await f.engine.syncNotion()
  assert.equal(f.engine.getSnapshot().error, null)
  assert.equal(f.fake.pages.size, 1)
  assert.equal(f.fake.files.size, before + 1)
  assert.deepEqual(page.properties.Audio, audio)
  assert.equal(page.properties.Status.select.name, 'Pending')
  f.engine.dispose()
})

test('metadata failure resumes after the audio upload without resending the audio file', async () => {
  const f = setup()
  let failMetadata = true
  f.port.notion = async (request) => {
    if (failMetadata && request.upload?.filename.endsWith('.json'))
      throw Error('metadata network failed')
    return f.fake.transport(request)
  }
  await f.engine.init()
  await f.engine.syncNotion()
  assert.ok(f.engine.getSnapshot().error)
  const sends = () => f.fake.requests.filter((r) => r.upload?.filename.endsWith('.ogg')).length
  assert.equal(sends(), 1)
  failMetadata = false
  await f.engine.syncNotion()
  assert.equal(f.engine.getSnapshot().error, null)
  assert.equal(sends(), 1)
  assert.equal(f.fake.pages.size, 1)
  assert.equal(f.engine.getSnapshot().recordings[0].uploaded, 1)
  f.engine.dispose()
})

test('fully attached Uploading pages recover to Pending even when no local upload is pending', async () => {
  const f = setup()
  await f.engine.init()
  await f.engine.syncNotion()
  const page = [...f.fake.pages.values()][0]
  page.properties.Status = { select: { name: 'Uploading' } }
  const before = f.fake.files.size
  await f.engine.syncNotion()
  assert.equal(page.properties.Status.select.name, 'Pending')
  assert.equal(f.fake.files.size, before)
  assert.equal(f.engine.getSnapshot().recordings[0].uploaded, 1)
  f.engine.dispose()
})

test('out-of-order chunk attachments only acknowledge the contiguous prefix of a source packet', async () => {
  const f = setup()
  const frames = Array.from({ length: 100 }, (_, i) => ({
    ...f.record.frames[0],
    id: `ordered-${i}`,
    offsetMs: i * 20,
  }))
  f.data.set(f.record.key, JSON.stringify({ ...f.record, frames, uploaded: 0 }))
  const settings = JSON.parse(f.data.get('settings')!)
  settings.segmentSeconds = 1
  f.data.set('settings', JSON.stringify(settings))
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  let sawLater = false
  f.port.notion = async (request) => {
    const properties = (request.body as any)?.properties
    if (properties?.Audio && properties?.Manifest) {
      const manifestId = properties.Manifest.files[0].file_upload.id
      const manifest = JSON.parse(Buffer.from(f.fake.files.get(manifestId)!).toString())
      if (manifest.frameIds[0] === 'ordered-0') await blocked
      else {
        sawLater = true
        assert.equal(JSON.parse(f.data.get(f.record.key)!).uploaded, 0)
        setTimeout(release, 5)
      }
    }
    return f.fake.transport(request)
  }
  await f.engine.init()
  await f.engine.syncNotion()
  assert.equal(f.engine.getSnapshot().error, null)
  assert.ok(sawLater)
  assert.equal(f.fake.pages.size, 2)
  assert.equal(JSON.parse(f.data.get(f.record.key)!).uploaded, 100)
  assert.deepEqual(JSON.parse(f.data.get(f.record.key)!).frames, frames)
  f.engine.dispose()
})

function verification(f: ReturnType<typeof setup>) {
  f.port.readNotionAudio = async (url, expected) => {
    const bytes = f.fake.files.get(url.split('/').at(-1)!)!
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected)
    return Buffer.from(bytes).toString('base64')
  }
  f.port.verifyNotionAudio = async (url, expected) => {
    const id = url.split('/').at(-1)!
    const bytes = f.fake.files.get(id)
    assert.ok(bytes, 'saved audio must exist')
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected)
  }
}
test('local audio is deleted only after remote audio and manifest read-back verification', async () => {
  const f = setup()
  verification(f)
  let verified = false
  const verify = f.port.verifyNotionAudio!
  f.port.verifyNotionAudio = async (url, hash) => {
    assert.ok(f.data.has(f.record.key))
    await verify(url, hash)
    verified = true
  }
  const remove = f.port.remove
  f.port.remove = async (key) => {
    if (key === f.record.key) assert.ok(verified)
    await remove(key)
  }
  await f.engine.init()
  await f.engine.syncNotion()
  assert.equal(f.engine.getSnapshot().error, null)
  assert.ok(verified)
  assert.equal(f.data.has(f.record.key), false)
  assert.ok(f.data.has(`seen:${f.record.key}`))
  assert.equal(f.fake.pages.size, 1)
  f.engine.dispose()
})
test('failed verification keeps originals and a later sync can verify and remove them', async () => {
  const f = setup()
  f.port.verifyNotionAudio = async () => {
    throw Error('hash mismatch')
  }
  await f.engine.init()
  await f.engine.syncNotion()
  assert.match(f.engine.getSnapshot().error!, /hash mismatch/)
  assert.ok(f.data.has(f.record.key))
  assert.equal(JSON.parse(f.data.get(f.record.key)!).uploaded, 1) // legacy counter is still untouched on disk
  verification(f)
  await f.engine.syncNotion()
  assert.equal(f.engine.getSnapshot().error, null)
  assert.equal(f.data.has(f.record.key), false)
  assert.equal(f.fake.pages.size, 1)
  f.engine.dispose()
})
test('lightweight catalog initialization never loads source audio; upload uses batched range reads and deletion', async () => {
  const f = setup()
  verification(f)
  const { recordIndex } = await import('../src/core/catalog')
  let rawReads = 0
  let batches = 0
  const get = f.port.get
  f.port.get = async (key) => {
    if (key.startsWith('record:')) rawReads++
    return get(key)
  }
  f.port.catalogEntries = async (after) =>
    [...f.data]
      .filter(([key]) => key.startsWith('record:') && key > after)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 256)
      .map(([key, value]) => ({ key, value: JSON.stringify(recordIndex(JSON.parse(value))) }))
  f.port.getMany = async (keys) =>
    keys.flatMap((key) => {
      if (key.startsWith('record:')) rawReads++
      const value = f.data.get(key)
      return value ? [{ key, value }] : []
    })
  f.port.batch = async (puts, removes = []) => {
    batches++
    for (const entry of puts) f.data.set(entry.key, entry.value)
    for (const key of removes) f.data.delete(key)
  }
  await f.engine.init()
  assert.equal(rawReads, 0)
  assert.equal(f.engine.getSnapshot().recordings.length, 0)
  assert.equal(f.engine.getSnapshot().catalog?.length, 1)
  await f.engine.syncNotion()
  assert.equal(f.engine.getSnapshot().error, null)
  assert.ok(rawReads > 0 && batches > 0)
  assert.equal(f.data.has(f.record.key), false)
  f.engine.dispose()
})
test('a second sync uses cached manifests and avoids per-page status GET requests', async () => {
  const f = setup()
  await f.engine.init()
  await f.engine.syncNotion()
  let manifests = 0
  const attachment = f.port.notionFile!
  f.port.notionFile = async (id, property) => {
    if (property === 'Manifest') manifests++
    return attachment(id, property)
  }
  const before = f.fake.requests.length
  await f.engine.syncNotion()
  assert.equal(f.engine.getSnapshot().error, null)
  assert.equal(manifests, 0)
  const calls = f.fake.requests.slice(before)
  assert.ok(!calls.some((r) => r.method === 'GET' && r.path.startsWith('/pages/')))
  const query = calls.find((r) => r.path.endsWith('/query'))
  assert.ok(JSON.stringify(query.body).includes('last_edited_time'))
  f.engine.dispose()
})

test('a self-consistent remote file with different source packets never authorizes local deletion', async () => {
  const f = setup()
  verification(f)
  const { NotionStore } = await import('@uomi/notion')
  const { oggOpus } = await import('../src/core/playback')
  const audio = oggOpus([{ ...f.record.frames[0], data: 'mAI=' }])
  const store = new NotionStore(f.fake.transport, SOURCE)
  await store.saveAudio(
    {
      schema: 'uomi.notion.v1',
      id: 'wrong-file',
      deviceId: f.record.deviceId,
      capturedAt: f.record.capturedAt,
      durationMs: 20,
      sha256: createHash('sha256').update(audio).digest('hex'),
      frameIds: [f.record.frames[0].id],
      timing: [
        {
          sequence: f.record.sequence,
          ringId: f.record.ringId,
          timestamp: f.record.timestampRaw,
          capturedAt: f.record.capturedAt,
          firstFrame: 0,
          frames: 1,
        },
      ],
    },
    audio,
  )
  const original = f.data.get(f.record.key)
  await f.engine.init()
  await f.engine.syncNotion()
  assert.match(f.engine.getSnapshot().error!, /differs from its local source/)
  assert.equal(f.data.get(f.record.key), original)
  assert.ok(!f.data.has(`seen:${f.record.key}`))
  f.engine.dispose()
})
test('failed atomic removal retains originals and does not create a deletion tombstone', async () => {
  const f = setup()
  verification(f)
  f.port.batch = async (puts, removes = []) => {
    if (removes.includes(f.record.key)) throw Error('Disk full during removal transaction')
    for (const entry of puts) f.data.set(entry.key, entry.value)
    for (const key of removes) f.data.delete(key)
  }
  await f.engine.init()
  await f.engine.syncNotion()
  assert.match(f.engine.getSnapshot().error!, /Disk full/)
  assert.ok(f.data.has(f.record.key))
  assert.ok(!f.data.has(`seen:${f.record.key}`))
  assert.equal(f.fake.pages.size, 1)
  f.engine.dispose()
})
test('source packet timing changes in the uploaded manifest prevent automatic deletion', async () => {
  const f = setup()
  verification(f)
  const attachment = f.port.notionFile!
  f.port.notionFile = async (id, property) => {
    const value = await attachment(id, property)
    if (property !== 'Manifest') return value
    const manifest = JSON.parse(value)
    manifest.capturedAt = '2026-01-01T01:00:00Z'
    return JSON.stringify(manifest)
  }
  await f.engine.init()
  await f.engine.syncNotion()
  assert.match(f.engine.getSnapshot().error!, /metadata differs/)
  assert.ok(f.data.has(f.record.key))
  f.engine.dispose()
})
test('nearby recordings upload together with explicit silent-gap metadata and no source re-encoding', async () => {
  const f = setup()
  verification(f)
  const first = {
    ...f.record,
    uploaded: 0,
    frames: Array.from({ length: 50 }, (_, i) => ({
      ...f.record.frames[0],
      id: `first:${i}`,
      offsetMs: 20 * i,
    })),
  }
  const second = {
    ...first,
    key: 'record:second',
    sequence: '100',
    capturedAt: '2026-01-01T00:00:10Z',
    frames: first.frames.map((frame, i) => ({ ...frame, id: `second:${i}` })),
  }
  f.data.set(first.key, JSON.stringify(first))
  f.data.set(second.key, JSON.stringify(second))
  const progress: NonNullable<ReturnType<Engine['getSnapshot']>['progress']>[] = []
  f.engine.subscribe(() => {
    const p = f.engine.getSnapshot().progress
    if (p) progress.push(p)
  })
  await f.engine.init()
  await f.engine.syncNotion()
  assert.equal(f.engine.getSnapshot().error, null)
  assert.equal(f.fake.pages.size, 1)
  const page = [...f.fake.pages.values()][0]
  const manifest = JSON.parse(await f.fake.attachment(page.id, 'Manifest'))
  assert.deepEqual(manifest.gaps, [{ beforeFrame: 50, durationMs: 9000, offsetMs: 1000 }])
  assert.equal(manifest.frameIds.length, 100)
  assert.equal(manifest.durationMs, 11000)
  assert.ok(progress.some((p) => p.chunkIndex === 1 && p.chunksTotal === 1))
  assert.ok(!f.data.has(first.key) && !f.data.has(second.key))
  f.engine.dispose()
})

test('native Notion sync works without an optional transcriber endpoint and reuses its page', async () => {
  const f = setup()
  const settings = JSON.parse(f.data.get('settings')!)
  settings.transcriberEndpoint = ''
  f.data.set('settings', JSON.stringify(settings))
  f.port.reserveNotion = async () => {
    throw Error('Coordinator must not be called without an endpoint')
  }
  await f.engine.init()
  f.fake.failAttach = true
  await f.engine.syncNotion()
  assert.ok(f.engine.getSnapshot().error)
  assert.equal(f.fake.pages.size, 1)
  assert.ok(f.data.has(f.record.key))
  f.fake.failAttach = false
  await f.engine.syncNotion()
  assert.equal(f.engine.getSnapshot().error, null)
  assert.equal(f.fake.pages.size, 1)
  assert.equal([...f.fake.pages.values()][0].properties.Status.select.name, 'Pending')
  assert.equal(f.notifications(), 0)
  await f.engine.syncNotion()
  assert.equal(f.fake.pages.size, 1)
  f.engine.dispose()
})
test('native Notion sync still reserves through the configured coordinator', async () => {
  const f = setup()
  let calls = 0
  f.port.reserveNotion = async (endpoint, manifest) => {
    assert.equal(endpoint, 'https://mac.example/webhook')
    calls++
    const { NotionStore } = await import('../../../packages/notion/src/index')
    return (await new NotionStore(f.fake.transport, SOURCE).reserve(manifest)).id
  }
  await f.engine.init()
  await f.engine.syncNotion()
  assert.equal(f.engine.getSnapshot().error, null)
  assert.equal(calls, 1)
  assert.equal(f.fake.pages.size, 1)
  f.engine.dispose()
})

test('failed Notion sync releases Retry and clears ETA before a slow catalog rebuild finishes', async () => {
  const f = setup()
  const originalList = f.port.list
  const originalNotion = f.port.notion!
  let failed = false
  let blocked = false
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.port.notion = async (request) => {
    try {
      return await originalNotion(request)
    } catch (error) {
      failed = true
      throw error
    }
  }
  f.port.list = async (prefix) => {
    if (failed && prefix === 'record:' && !blocked) {
      blocked = true
      await gate
    }
    return originalList(prefix)
  }
  await f.engine.init()
  f.fake.failAttach = true
  await f.engine.syncNotion()
  assert.equal(blocked, true)
  assert.equal(f.engine.getSnapshot().busy, false)
  assert.equal(f.engine.getSnapshot().progress, null)
  assert.match(f.engine.getSnapshot().error!, /503/)
  assert.ok(f.data.has(f.record.key))
  // Retry can finish before the previous read-only rebuild; it must not reset
  // the new attempt's error/busy state or overwrite the refreshed library.
  f.fake.failAttach = false
  await f.engine.syncNotion()
  assert.equal(f.engine.getSnapshot().error, null)
  assert.equal(f.fake.pages.size, 1)
  release()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(f.engine.getSnapshot().error, null)
  assert.equal(f.engine.getSnapshot().recordings[0].uploaded, 1)
  f.engine.dispose()
})

test('Notion reconciliation and resumed planning publish completed page and checkpoint counts', async () => {
  const f = setup()
  await f.engine.init()
  f.fake.failAttach = true
  await f.engine.syncNotion()
  const events: import('../src/core/types').SyncProgress[] = []
  const unsubscribe = f.engine.subscribe(() => {
    const value = f.engine.getSnapshot().progress
    if (value) events.push({ ...value })
  })
  f.port.mirrorCount = async () => f.fake.pages.size
  f.fake.failAttach = false
  await f.engine.syncNotion()
  assert.equal(f.engine.getSnapshot().error, null)
  assert.ok(events.some((p) => p.unit === 'pages' && p.total === 1 && p.completed === 1))
  assert.ok(events.some((p) => p.unit === 'checkpoints' && p.total === 1 && p.completed === 1))
  assert.ok(
    events.some((p) => p.detail === 'Planning audio chunks' && p.total === 1 && p.completed === 1),
  )
  assert.ok(events.some((p) => p.detail === 'Upload plan ready' && p.plannedChunks === 1))
  assert.equal(f.fake.pages.size, 1)
  unsubscribe()
  f.engine.dispose()
})
