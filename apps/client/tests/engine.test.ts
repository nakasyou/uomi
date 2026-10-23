import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Buffer } from 'buffer'
import { Engine } from '../src/core/engine'
import { defaults, type Port } from '../src/core/types'
import { UUID } from '../src/core/protocol'
function fixture(recordCount = 1) {
  const data = new Map<string, string>()
  data.set(
    'settings',
    JSON.stringify({
      ...defaults,
      endpoint: 'https://example.test/audio',
      deviceAddress: 'AA',
    }),
  )
  let listener: ((s: string) => void) | undefined
  const commands: Buffer[] = []
  let posts = 0
  let failPost = false
  let failStorage = false
  let safe = true
  const record = Buffer.alloc(444)
  record.writeUInt32BE(1767225600)
  record[4] = 2
  record[5] = 0x98
  record[6] = 1
  const port: Port = {
    get: async (k) => data.get(k) ?? null,
    put: async (k, v) => {
      if (failStorage && k.startsWith('record:')) throw Error('Disk full')
      data.set(k, v)
    },
    remove: async (k) => {
      data.delete(k)
    },
    list: async (p) => [...data.keys()].filter((k) => k.startsWith(p)),
    secret: async () => 'secret',
    hash: async (v) => createHash('sha256').update(Buffer.from(v, 'base64')).digest('hex'),
    scan: async () => [],
    connect: async () => {},
    disconnect: async () => {},
    wifi: async () => true,
    schedule: async () => {},
    read: async (_s, c) =>
      Buffer.from(
        c === UUID.serial
          ? 'serial'
          : c === UUID.firmware
            ? '3.0.20'
            : c === UUID.codec
              ? [21]
              : [85],
      ).toString('base64'),
    subscribe: async (_s, _c, l) => {
      if (_s === UUID.omi) return async () => {}
      listener = l
      return async () => {
        listener = undefined
      }
    },
    write: async (_s, c, v) => {
      if (c !== UUID.control) return
      const b = Buffer.from(v, 'base64')
      commands.push(b)
      const emit = (x: Buffer) => listener?.(x.toString('base64'))
      if (b[0] === 0x10) {
        const info = Buffer.alloc(41)
        info[0] = 2
        info.writeBigUInt64BE(BigInt(recordCount), 9)
        info.writeUInt16BE(444, 29)
        info.writeBigUInt64BE(321n, 33)
        info[31] = safe ? 15 : 0
        info[32] = safe ? 1 : 0
        emit(info)
      }
      if (b[0] === 0x14) emit(Buffer.from([1, 0, 15]))
      if (b[0] === 0x11) {
        const begin = Buffer.alloc(13)
        begin[0] = 5
        begin.writeBigUInt64BE(b.readBigUInt64BE(1), 1)
        begin.writeUInt32BE(b.readUInt32BE(9), 9)
        emit(begin)
        for (let i = 0; i < b.readUInt32BE(9); i++) {
          emit(Buffer.concat([Buffer.from([3]), record.subarray(0, 70)]))
          emit(Buffer.concat([Buffer.from([3]), record.subarray(70)]))
        }
        const done = Buffer.alloc(10)
        done[0] = 4
        done.writeBigUInt64BE(b.readBigUInt64BE(1) + BigInt(b.readUInt32BE(9)), 2)
        emit(done)
      }
    },
    post: async () => {
      posts++
      if (failPost) throw Error('HTTP 503')
      return true
    },
  }
  return {
    port,
    data,
    commands,
    set safe(v: boolean) {
      safe = v
    },
    get posts() {
      return posts
    },
    set failPost(v: boolean) {
      failPost = v
    },
    set failStorage(v: boolean) {
      failStorage = v
    },
  }
}
test('manual sync durably saves packet before upload and never deletes device audio', async () => {
  const f = fixture()
  const e = new Engine(f.port)
  await e.init()
  await e.sync()
  assert.equal(f.posts, 1)
  assert.equal(e.getSnapshot().recordings[0].uploaded, 1)
  assert.ok(e.getSnapshot().lastSync)
  assert.ok(!f.commands.some((b) => [0x12, 0x13, 0x15].includes(b[0])))
  assert.equal(f.data.get('cursor:serial:321'), '1')
  await e.sync()
  assert.equal(f.posts, 1)
  e.dispose()
})
test('HTTP failure keeps audio queued and retries after restart with same frame identity', async () => {
  const f = fixture()
  f.failPost = true
  const e = new Engine(f.port)
  await e.init()
  await e.sync()
  assert.equal(e.getSnapshot().lastSync, null)
  const before = e.getSnapshot().recordings[0]
  assert.equal(before.uploaded, 0)
  e.dispose()
  f.failPost = false
  const restarted = new Engine(f.port)
  await restarted.init()
  await restarted.sync()
  assert.equal(restarted.getSnapshot().recordings[0].frames[0].id, before.frames[0].id)
  assert.equal(restarted.getSnapshot().recordings[0].uploaded, 1)
  restarted.dispose()
})
test('disk failure never advances durable cursor or uploads uncommitted audio', async () => {
  const f = fixture()
  f.failStorage = true
  const e = new Engine(f.port)
  await e.init()
  await e.sync()
  assert.equal(f.data.has('cursor:serial:321'), false)
  assert.equal(f.posts, 0)
  assert.match(e.getSnapshot().error! ?? '', /Disk full/)
  e.dispose()
})
test('purging delivered audio leaves a tombstone against a repeated device read', async () => {
  const f = fixture()
  const e = new Engine(f.port)
  await e.init()
  await e.sync()
  await e.clearDelivered()
  assert.equal(e.getSnapshot().recordings.length, 0)
  f.data.delete('cursor:serial:321')
  await e.sync()
  assert.equal(f.posts, 1)
  assert.equal(e.getSnapshot().recordings.length, 0)
  e.dispose()
})
test('manual mode cannot be woken by periodic or real-time jobs', async () => {
  const f = fixture()
  const e = new Engine(f.port)
  await e.init()
  await e.sync('periodic')
  await e.sync('realtime')
  assert.equal(f.commands.length, 0)
  assert.equal(f.posts, 0)
  e.dispose()
})
test('background periodic sync requires actual Wi-Fi', async () => {
  const f = fixture()
  f.data.set(
    'settings',
    JSON.stringify({
      ...defaults,
      mode: 'periodic',
      endpoint: 'https://example.test/audio',
      deviceAddress: 'AA',
    }),
  )
  f.port.wifi = async () => false
  const e = new Engine(f.port)
  await e.init()
  await e.sync('periodic')
  assert.equal(f.commands.length, 0)
  e.dispose()
})

test('stock firmware imports without custody negotiation and retains delivered audio', async () => {
  const f = fixture()
  f.safe = false
  const e = new Engine(f.port)
  await e.init()
  await e.sync()
  assert.equal(e.getSnapshot().error, null)
  assert.equal(f.posts, 1)
  assert.equal(e.getSnapshot().recordings.length, 1)
  assert.equal(e.getSnapshot().recordings[0].uploaded, 1)
  assert.ok(f.commands.some((b) => b[0] === 0x11))
  assert.ok(!f.commands.some((b) => [0x12, 0x13, 0x14].includes(b[0])))
  await e.sync()
  const restarted = new Engine(f.port)
  await restarted.init()
  assert.equal(restarted.getSnapshot().recordings.length, 1)
  assert.equal(f.posts, 1)
  restarted.dispose()
  e.dispose()
})

test('an unavailable keyring does not block local capture or manual settings', async () => {
  const f = fixture()
  f.port.secret = async () => {
    throw Error('Keyring locked')
  }
  const e = new Engine(f.port)
  await e.init()
  assert.equal(e.getSnapshot().settings.deviceAddress, 'AA')
  assert.match(e.getSnapshot().error ?? '', /Keyring locked/)
  await e.save({ ...e.getSnapshot().settings, compression: 'deflate' })
  await e.sync()
  assert.equal(e.getSnapshot().recordings.length, 1)
  assert.equal(e.getSnapshot().recordings[0].uploaded, 0)
  assert.equal(f.posts, 0)
  e.dispose()
})

test('a failed scheduler installation rolls settings back', async () => {
  const f = fixture()
  const e = new Engine(f.port)
  await e.init()
  f.port.schedule = async (s) => {
    if (s.mode === 'periodic') throw Error('No systemd user session')
  }
  await assert.rejects(() => e.save({ ...e.getSnapshot().settings, mode: 'periodic' }), /systemd/)
  assert.equal(e.getSnapshot().settings.mode, 'manual')
  assert.equal(JSON.parse(f.data.get('settings')!).mode, 'manual')
  e.dispose()
})

for (const serialValue of [null, '', 'unknown', '00000000']) {
  test(`pair accepts optional serial ${JSON.stringify(serialValue)} and normalizes platform addresses`, async () => {
    const identities: string[] = []
    for (const address of ['hci0/dev_E1_4C_97_C4_62_71', 'e1:4c:97:c4:62:71']) {
      const f = fixture()
      const read = f.port.read
      f.port.read = async (service, char) => {
        if (char !== UUID.serial) return read(service, char)
        if (serialValue === null) throw Error('Missing characteristic 0x2A25')
        return Buffer.from(serialValue).toString('base64')
      }
      const e = new Engine(f.port)
      await e.init()
      await e.pair({ address, name: 'Omi CV2' })
      identities.push(e.getSnapshot().device!.serial!)
      assert.equal(e.getSnapshot().settings.deviceAddress, address)
    }
    assert.deepEqual(identities, ['ble:E1:4C:97:C4:62:71', 'ble:E1:4C:97:C4:62:71'])
  })
}

test('saved imports are delivered even if the next device connection fails', async () => {
  const f = fixture()
  f.safe = false
  f.failPost = true
  const e = new Engine(f.port)
  await e.init()
  await e.sync()
  const key = e.getSnapshot().recordings[0].key
  f.failPost = false
  f.port.connect = async () => {
    throw Error('Device disconnected')
  }
  await e.sync()
  assert.equal(f.posts, 2)
  assert.equal(e.getSnapshot().recordings[0].key, key)
  assert.equal(e.getSnapshot().recordings[0].uploaded, 1)
  assert.ok(f.data.has(key))
  e.dispose()
})

test('progress counts committed imports and acknowledged uploads separately', async () => {
  const f = fixture()
  const e = new Engine(f.port)
  await e.init()
  const updates: unknown[] = []
  const unsubscribe = e.subscribe(() => {
    const progress = e.getSnapshot().progress
    if (progress) updates.push({ ...progress })
  })
  await e.sync()
  for (const stage of ['import', 'upload']) {
    assert.ok(
      updates.some(
        (p) => (p as any).stage === stage && (p as any).completed === 0 && (p as any).total === 1,
      ),
    )
    assert.ok(
      updates.some(
        (p) => (p as any).stage === stage && (p as any).completed === 1 && (p as any).total === 1,
      ),
    )
  }
  unsubscribe()
  e.dispose()
})

test('failed webhook delivery never claims uploaded progress and clears the stopped progress display', async () => {
  const f = fixture()
  f.failPost = true
  const e = new Engine(f.port)
  await e.init()
  const completed: number[] = []
  const unsubscribe = e.subscribe(() => {
    const progress = e.getSnapshot().progress
    if (progress?.stage === 'upload') completed.push(progress.completed)
  })
  await e.sync()
  assert.ok(completed.length > 0)
  assert.ok(completed.every((count) => count === 0))
  assert.equal(e.getSnapshot().progress, null)
  assert.equal(e.getSnapshot().busy, false)
  assert.equal(e.getSnapshot().recordings[0].uploaded, 0)
  unsubscribe()
  e.dispose()
})

test('bulk import limits progress notifications without skipping durable records', async () => {
  const f = fixture(128)
  const e = new Engine(f.port)
  await e.init()
  let importNotifications = 0
  let saved = 0
  const put = f.port.put
  f.port.put = async (key, value) => {
    if (key.startsWith('record:') && JSON.parse(value).uploaded === 0) saved++
    await put(key, value)
  }
  const unsubscribe = e.subscribe(() => {
    if (e.getSnapshot().progress?.stage === 'import') importNotifications++
  })
  // A fixed clock represents a burst arriving within one paint interval.
  const now = Date.now
  Date.now = () => 1000000
  try {
    await e.sync()
  } finally {
    Date.now = now
  }
  assert.equal(saved, 128)
  assert.equal(e.getSnapshot().recordings.length, 128)
  assert.ok(importNotifications <= 4, `Got ${importNotifications} import notifications`)
  unsubscribe()
  e.dispose()
})

test('debug monitor uses live notifications only, blocks sync, and releases on background', async () => {
  const f = fixture()
  const e = new Engine(f.port)
  await e.init()
  let listener: ((data: string) => void) | undefined
  let unsubscribed = false
  let disconnected = 0
  const frames: string[] = []
  f.port.disconnect = async () => {
    disconnected++
  }
  f.port.subscribe = async (service, char, callback) => {
    assert.equal(service, UUID.omi)
    assert.equal(char, UUID.audio)
    listener = callback
    return async () => {
      unsubscribed = true
    }
  }
  await e.startMonitor((frame) => frames.push(frame.data))
  listener!(Buffer.from([0, 0, 0, 0x98, 1]).toString('base64'))
  listener!(Buffer.from([1, 0, 0, 0x98, 2]).toString('base64'))
  assert.equal(frames.length, 1)
  await e.sync()
  assert.equal(f.posts, 0)
  assert.equal(f.commands.length, 0)
  assert.equal([...f.data.keys()].filter((k) => k.startsWith('record:')).length, 0)
  await assert.rejects(() => e.save(e.getSnapshot().settings), /Stop live monitoring/)
  await e.setActive(false)
  assert.ok(unsubscribed)
  assert.ok(disconnected >= 2)
  listener!(Buffer.from([2, 0, 0, 0x98, 3]).toString('base64'))
  assert.equal(frames.length, 1)
  e.dispose()
})

function gainFixture() {
  const f = fixture()
  let gain = 4
  let connects = 0
  let disconnects = 0
  const writes: number[] = []
  const read = f.port.read
  f.port.read = async (service, char) =>
    char === UUID.micGain ? Buffer.from([gain]).toString('base64') : read(service, char)
  f.port.write = async (service, char, value) => {
    assert.equal(service, UUID.settings)
    assert.equal(char, UUID.micGain)
    const bytes = Buffer.from(value, 'base64')
    assert.equal(bytes.length, 1)
    writes.push(bytes[0])
    gain = bytes[0]
  }
  f.port.connect = async () => {
    connects++
  }
  f.port.disconnect = async () => {
    disconnects++
  }
  return {
    f,
    writes,
    get gain() {
      return gain
    },
    get connects() {
      return connects
    },
    get disconnects() {
      return disconnects
    },
  }
}
test('microphone gain reads without overwriting and applies each firmware level', async () => {
  const g = gainFixture()
  const e = new Engine(g.f.port)
  await e.init()
  assert.equal(await e.micGain(), 4)
  assert.deepEqual(g.writes, [])
  for (const level of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
    assert.equal(await e.micGain(level), level)
    assert.equal(e.getSnapshot().device?.micGain, level)
    assert.equal(e.getSnapshot().busy, false)
  }
  assert.equal(g.connects, 10)
  assert.equal(g.disconnects, 10)
  e.dispose()
})
test('microphone gain rejects invalid levels before any device write', async () => {
  const g = gainFixture()
  const e = new Engine(g.f.port)
  await e.init()
  for (const level of [-1, 9, 1.5, NaN, Infinity])
    await assert.rejects(() => e.micGain(level), /0 to 8/)
  assert.equal(g.connects, 0)
  assert.deepEqual(g.writes, [])
  e.dispose()
})
test('microphone gain preserves the live monitor connection', async () => {
  const g = gainFixture()
  const e = new Engine(g.f.port)
  await e.init()
  await e.startMonitor(() => {})
  const connects = g.connects
  const disconnects = g.disconnects
  assert.equal(await e.micGain(6), 6)
  assert.equal(g.connects, connects)
  assert.equal(g.disconnects, disconnects)
  await e.stopMonitor()
  e.dispose()
})
test('unsupported microphone gain never writes and releases busy state', async () => {
  const g = gainFixture()
  const e = new Engine(g.f.port)
  await e.init()
  g.f.port.read = async () => Buffer.from([40]).toString('base64')
  await assert.rejects(() => e.micGain(6), /supported 0–8/)
  assert.deepEqual(g.writes, [])
  assert.equal(e.getSnapshot().busy, false)
  assert.equal(g.disconnects, 1)
  e.dispose()
})
test('microphone gain readback mismatch is surfaced instead of claiming success', async () => {
  const g = gainFixture()
  const e = new Engine(g.f.port)
  await e.init()
  g.f.port.write = async () => {}
  await assert.rejects(() => e.micGain(6), /reported gain level 4/)
  assert.equal(e.getSnapshot().device?.micGain, undefined)
  assert.equal(e.getSnapshot().busy, false)
  e.dispose()
})
test('explicit Omi import saves locally without credentials or any upload and preserves the cloud sync time', async () => {
  const f = fixture()
  f.port.secret = async () => ''
  f.port.notion = async () => {
    throw Error('Import must not call Notion')
  }
  const e = new Engine(f.port)
  await e.init()
  await e.importDevice()
  assert.equal(e.getSnapshot().error, null)
  assert.equal(e.getSnapshot().recordings.length, 1)
  assert.equal(e.getSnapshot().recordings[0].uploaded, 0)
  assert.equal(f.posts, 0)
  assert.equal(e.getSnapshot().lastSync, null)
  assert.ok(e.getSnapshot().lastDeviceSync)
  assert.equal(f.data.get('lastDeviceSync'), e.getSnapshot().lastDeviceSync)
  e.dispose()
})

test('refresh reads bounded storage pages without per-record IPC or modifying stored audio', async () => {
  const f = fixture()
  const seed = new Engine(f.port)
  await seed.init()
  await seed.sync()
  seed.dispose()
  const original = [...f.data].find(([key]) => key.startsWith('record:'))![1]
  for (let i = 0; i < 600; i++) {
    f.data.set(`record:bulk:${String(i).padStart(4, '0')}`, original)
  }
  const before = new Map(f.data)
  let pages = 0
  const get = f.port.get
  f.port.get = async (key) => {
    assert.ok(!key.startsWith('record:'))
    return get(key)
  }
  f.port.entries = async (prefix, after) => {
    pages++
    return [...f.data]
      .filter(([key]) => key.startsWith(prefix) && key > after)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, 256)
      .map(([key, value]) => ({ key, value }))
  }
  const engine = new Engine(f.port)
  const counts: number[] = []
  engine.subscribe(() => {
    const count = engine.getSnapshot().loadingRecords
    if (count !== undefined) counts.push(count)
  })
  await engine.init()
  assert.equal(engine.getSnapshot().recordings.length, 601)
  assert.equal(pages, 4)
  assert.ok(counts.includes(256) && counts.includes(512) && counts.includes(601))
  assert.equal(engine.getSnapshot().loadingRecords, undefined)
  assert.deepEqual(f.data, before)
  engine.dispose()
})

test('native import uses bounded 1024-packet ranges without per-packet JS hashing or writes', async () => {
  const f = fixture(2050)
  const ranges: import('../src/core/types').ImportRequest[] = []
  f.port.hash = async () => {
    throw Error('Bulk audio must stay native')
  }
  f.port.importRing = async (request, progress) => {
    ranges.push(request)
    const metrics = {
      completed: request.count,
      elapsedMs: 1000,
      storageMs: 100,
      receivedBytes: request.count * 444,
      maxNotificationBytes: 495,
      mtu: 498,
      rxPhy: 2,
    }
    f.data.set(request.cursorKey, (BigInt(request.start) + BigInt(request.count)).toString())
    progress(metrics)
    return metrics
  }
  const e = new Engine(f.port)
  await e.init()
  await e.importDevice()
  assert.equal(e.getSnapshot().error, null)
  assert.deepEqual(
    ranges.map((r) => [r.start, r.count, r.finalRange]),
    [
      ['0', 1024, false],
      ['1024', 1024, false],
      ['2048', 2, true],
    ],
  )
  assert.equal(e.getSnapshot().transfer?.completed, 2050)
  assert.equal(e.getSnapshot().transfer?.receivedBytes, 2050 * 444)
  assert.equal(e.getSnapshot().transfer?.elapsedMs, 3000)
  assert.equal(f.data.get('cursor:serial:321'), '2050')
  assert.ok(!f.commands.some((b) => b[0] === 0x11))
  assert.ok(e.getSnapshot().lastDeviceSync)
  e.dispose()
})
test('native import cancellation propagates when a manual client leaves the foreground', async () => {
  const f = fixture(1024)
  let entered!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  let reject!: (error: Error) => void
  let cancelled = 0
  f.port.importRing = async () =>
    new Promise((_resolve, fail) => {
      reject = fail
      entered()
    })
  f.port.cancelImport = async () => {
    cancelled++
    reject(Error('Import paused'))
  }
  const e = new Engine(f.port)
  await e.init()
  await e.setActive(true)
  const pending = e.importDevice()
  await ready
  await e.setActive(false)
  await pending
  assert.equal(cancelled, 1)
  assert.match(e.getSnapshot().error!, /Import paused/)
  assert.equal(e.getSnapshot().lastDeviceSync, null)
  e.dispose()
})
test('native import rejects incomplete completion rather than claiming a successful import', async () => {
  const f = fixture(64)
  f.port.importRing = async () => ({
    completed: 32,
    elapsedMs: 100,
    storageMs: 10,
    receivedBytes: 32 * 444,
    maxNotificationBytes: 495,
  })
  const e = new Engine(f.port)
  await e.init()
  await e.importDevice()
  assert.match(e.getSnapshot().error!, /Incomplete native import/)
  assert.equal(e.getSnapshot().lastDeviceSync, null)
  e.dispose()
})

test('an unconfirmed API receipt retains local audio; primary server confirmation permits explicit removal', async () => {
  const f = fixture()
  const e = new Engine(f.port)
  await e.init()
  f.port.post = async () => false
  await e.sync()
  assert.equal(e.getSnapshot().recordings[0].uploaded, 0)
  await e.clearDelivered()
  assert.equal(e.getSnapshot().recordings.length, 1)
  f.port.post = async () => true
  await e.syncCloud()
  assert.equal(e.getSnapshot().recordings[0].uploaded, 1)
  await e.clearDelivered()
  assert.equal(e.getSnapshot().recordings.length, 0)
  e.dispose()
})

test('upload muxes on the client and passes binary Ogg with metadata instead of JSON audio frames', async () => {
  const { oggOpus, decodeOggUpload } = await import('@uomi/audio')
  const f = fixture()
  let muxed: Uint8Array | undefined
  let sent = false
  f.port.muxAudio = async (frames) => (muxed = oggOpus(frames))
  f.port.post = async (_endpoint, _header, body, compression, id, binary) => {
    assert.equal(binary, true)
    assert.equal(compression, 'none')
    const { audio, manifest: raw } = decodeOggUpload(Buffer.from(body, 'base64'))
    const manifest = raw as import('@uomi/notion').AudioManifest
    assert.deepEqual(audio, muxed)
    assert.equal(manifest.id, id)
    assert.equal(manifest.sha256, createHash('sha256').update(audio).digest('hex'))
    assert.equal(manifest.frameIds.length, 1)
    assert.equal(manifest.timing[0].frames, 1)
    assert.equal('frames' in manifest, false)
    sent = true
    return false
  }
  const e = new Engine(f.port)
  await e.init()
  await e.sync()
  assert.ok(sent)
  assert.equal(e.getSnapshot().recordings[0].uploaded, 0)
  e.dispose()
})

function localAudioFixture(frames = 4) {
  const f = fixture()
  f.data.set(
    'record:parallel',
    JSON.stringify({
      key: 'record:parallel',
      deviceId: 'serial',
      ringId: '321',
      sequence: '1',
      capturedAt: '2026-01-01T00:00:00.000Z',
      timestampRaw: 1767225600,
      timing: 'device-utc',
      uploaded: 0,
      bytes: 2 * frames,
      receivedAt: '2026-01-01T00:00:00Z',
      frames: Array.from({ length: frames }, (_, i) => ({
        id: `serial:packet:${i}`,
        data: 'mAE=',
        durationMs: 20,
        offsetMs: i * 20,
      })),
    }),
  )
  f.port.planAudio = async (records) =>
    records.flatMap((r) =>
      Array.from({ length: r.frameCount }, (_, i) => ({
        key: `${r.key}:${i}`,
        deviceId: r.deviceId,
        capturedAt: r.capturedAt,
        durationMs: 20,
        sourceFrames: 1,
        deliveredFrames: 0,
        ranges: [{ key: r.key, from: i, to: i + 1, gapMs: 0 }],
        endReason: { kind: 'duration-limit' as const },
      })),
    )
  return f
}

test('four concurrent uploads retain every acknowledgement when chunks sharing a record finish out of order', async () => {
  const f = localAudioFixture(8)
  const { decodeOggUpload } = await import('@uomi/audio')
  let active = 0,
    maximum = 0
  const releases = new Map<number, () => void>()
  let ready!: () => void
  const firstFour = new Promise<void>((r) => {
    ready = r
  })
  f.port.post = async (_url, _header, body) => {
    const { manifest } = decodeOggUpload(Buffer.from(body, 'base64'))
    const i = Number(
      (manifest as import('@uomi/notion').AudioManifest).frameIds[0].split(':').at(-1),
    )
    maximum = Math.max(maximum, ++active)
    try {
      if (i < 4)
        await new Promise<void>((resolve) => {
          releases.set(i, resolve)
          if (releases.size === 4) ready()
        })
      return true
    } finally {
      active--
    }
  }
  const e = new Engine(f.port)
  await e.init()
  const running = e.syncCloud()
  try {
    await firstFour
    assert.equal(active, 4)
    assert.equal(e.getSnapshot().progress?.chunksActive, 4)
    for (const i of [3, 2, 1]) releases.get(i)!()
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(JSON.parse(f.data.get('record:parallel')!).uploaded, 0)
  } finally {
    releases.get(0)?.()
    await running
  }
  assert.equal(maximum, 4)
  assert.equal(e.getSnapshot().recordings[0].uploaded, 8)
  assert.equal(e.getSnapshot().progress?.chunksSubmitted, 8)
  assert.equal(e.getSnapshot().progress?.chunksCompleted, 8)
  assert.equal(e.getSnapshot().progress?.chunksActive, 0)
  e.dispose()
})

test('upload progress counts staged deliveries while save acknowledgements stay separate', async () => {
  const f = localAudioFixture(4)
  f.port.post = async () => false
  const e = new Engine(f.port)
  await e.init()
  await e.syncCloud()
  const s = e.getSnapshot()
  assert.equal(s.progress?.completed, 4)
  assert.equal(s.progress?.chunksSubmitted, 4)
  assert.equal(s.progress?.chunksCompleted, 0)
  assert.equal(s.progress?.chunksStaged, 4)
  assert.equal(s.recordings[0].uploaded, 0)
  assert.equal(s.busy, false)
  assert.match(s.phase, /Upload complete/)
  e.dispose()
})

test('a failed concurrent upload stops admission and drains active requests before enabling retry', async () => {
  const f = localAudioFixture(8)
  const { decodeOggUpload } = await import('@uomi/audio')
  let release!: () => void, reportFailure!: () => void
  const blocked = new Promise<void>((r) => {
    release = r
  })
  const failed = new Promise<void>((r) => {
    reportFailure = r
  })
  const started: number[] = []
  f.port.post = async (_url, _header, body) => {
    const { manifest } = decodeOggUpload(Buffer.from(body, 'base64'))
    const i = Number(
      (manifest as import('@uomi/notion').AudioManifest).frameIds[0].split(':').at(-1),
    )
    started.push(i)
    if (i === 0) {
      await blocked
      return true
    }
    reportFailure()
    throw Error('HTTP 503')
  }
  const e = new Engine(f.port)
  await e.init()
  const running = e.syncCloud()
  await failed
  assert.equal(e.getSnapshot().busy, true)
  release()
  await running
  assert.ok(started.length <= 4)
  assert.equal(e.getSnapshot().busy, false)
  assert.match(e.getSnapshot().error!, /HTTP 503/)
  assert.equal(JSON.parse(f.data.get('record:parallel')!).uploaded, 1)
  e.dispose()
})

test('cached chunks are checked without loading, muxing or retransmitting audio; pending saves refresh automatically', async () => {
  const f = localAudioFixture(4)
  let checks = 0
  f.port.uploadStatus = async (_endpoint, _header, ids) => {
    checks++
    return ids.map((id) => ({ id, status: checks === 1 ? 'pending' : 'saved' }))
  }
  f.port.muxAudio = async () => {
    throw Error('Cached audio must not be loaded or muxed')
  }
  f.port.post = async () => {
    throw Error('Cached audio must not be retransmitted')
  }
  const e = new Engine(f.port)
  await e.init()
  await e.syncCloud()
  assert.equal(e.getSnapshot().error, null)
  assert.ok(checks >= 2)
  assert.equal(e.getSnapshot().progress?.chunksCompleted, 4)
  assert.equal(e.getSnapshot().progress?.chunksStaged, 0)
  assert.equal(e.getSnapshot().recordings[0].uploaded, 4)
  e.dispose()
})

test('save failures are distinct from pending saves and never cause automatic audio retransmission', async () => {
  const f = localAudioFixture(4)
  f.port.uploadStatus = async (_endpoint, _header, ids) =>
    ids.map((id) => ({ id, status: 'failed', error: 'Notion permission denied' }))
  f.port.post = async () => {
    throw Error('Failed saves must not retransmit received audio')
  }
  const e = new Engine(f.port)
  await e.init()
  await e.syncCloud()
  assert.match(e.getSnapshot().error!, /Notion permission denied/)
  assert.equal(e.getSnapshot().progress?.chunksSubmitted, 4)
  assert.equal(e.getSnapshot().progress?.chunksCompleted, 0)
  assert.equal(e.getSnapshot().recordings[0].uploaded, 0)
  e.dispose()
})

test('status responses must account for every requested identity before any upload', async () => {
  const f = localAudioFixture(4)
  f.port.uploadStatus = async () => []
  const e = new Engine(f.port)
  await e.init()
  await e.syncCloud()
  assert.match(e.getSnapshot().error!, /Invalid upload status response/)
  assert.equal(f.posts, 0)
  e.dispose()
})

test('primary server save remains successful when Notion backup fails; transcription job errors stay visible', async () => {
  const f = localAudioFixture(4)
  f.port.uploadStatus = async (_endpoint, _header, ids) =>
    ids.map((id) => ({
      id,
      status: 'saved',
      backup_status: 'failed',
      backup_error: 'Notion HTTP 403: integration has no access',
      transcription: {
        id: `job:${id}`,
        status: 'failed',
        stage: 'recognizing',
        progress: 0.6,
        attempt: 3,
        error: 'Provider quota exhausted',
      },
    }))
  f.port.post = async () => {
    throw Error('Saved primary audio must not be retransmitted')
  }
  const e = new Engine(f.port)
  await e.init()
  await e.syncCloud()
  assert.equal(e.getSnapshot().error, null)
  assert.equal(e.getSnapshot().progress?.chunksCompleted, 4)
  assert.equal(e.getSnapshot().recordings[0].uploaded, 4)
  assert.equal(e.getSnapshot().uploadJobs?.length, 4)
  assert.equal(e.getSnapshot().uploadJobs?.[0].transcription?.error, 'Provider quota exhausted')
  assert.match(e.getSnapshot().uploadJobs![0].backup_error!, /Notion HTTP 403/)
  await e.clearDelivered()
  assert.equal(e.getSnapshot().recordings.length, 0)
  e.dispose()
})

test('transcription job identity survives restart and completed status is restored', async () => {
  const f = localAudioFixture(1)
  let saved = false
  f.port.post = async () => {
    saved = true
    return true
  }
  f.port.uploadStatus = async (_endpoint, _header, ids) =>
    ids.map((id) => ({
      id,
      status: saved ? 'saved' : 'missing',
      transcription: saved
        ? { id: `job:${id}`, status: 'completed', stage: 'completed', progress: 1, attempt: 1 }
        : null,
    }))
  const first = new Engine(f.port)
  await first.init()
  await first.syncCloud()
  assert.equal(first.getSnapshot().uploadJobs?.[0].transcription?.status, 'completed')
  first.dispose()
  const second = new Engine(f.port)
  await second.init()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(second.getSnapshot().uploadJobs?.[0].transcription?.status, 'completed')
  second.dispose()
})

test('sync retains the upstream error when Bluetooth cleanup also fails', async () => {
  const f = fixture()
  const e = new Engine(f.port)
  await e.init()
  f.port.post = async () => {
    throw Error('HTTP 503: recording database unavailable')
  }
  f.port.disconnect = async () => {
    throw Error('BlueZ connection release failed')
  }
  await e.sync()
  assert.match(e.getSnapshot().error!, /HTTP 503: recording database unavailable/)
  assert.match(e.getSnapshot().error!, /BlueZ connection release failed/)
  assert.equal(e.getSnapshot().busy, false)
  assert.equal(e.getSnapshot().recordings[0].uploaded, 0)
  e.dispose()
})

test('native saved-status acknowledgements update metadata without rereading audio or rewriting source packets', async () => {
  const { recordIndex } = await import('../src/core/catalog')
  const f = localAudioFixture(8)
  let summary = recordIndex(JSON.parse(f.data.get('record:parallel')!))
  f.port.catalogEntries = async (after) =>
    after ? [] : [{ key: summary.key, value: JSON.stringify(summary) }]
  const get = f.port.get
  f.port.get = async (key) => {
    assert.ok(!key.startsWith('record:'), 'Acknowledgements must not fetch original audio')
    return get(key)
  }
  f.port.uploadStatus = async (_endpoint, _header, ids) =>
    ids.map((id) => ({ id, status: 'saved' }))
  f.port.post = async () => {
    throw Error('Saved server audio must not be retransmitted')
  }
  const original = f.data.get('record:parallel')
  let updates = 0
  f.port.acknowledgeAudio = async (batch) => {
    assert.ok(batch.length <= 256)
    for (const update of batch) {
      assert.ok(update.uploaded >= summary.uploaded)
      summary = { ...summary, uploaded: update.uploaded, notionTarget: update.target }
      updates++
    }
  }
  const e = new Engine(f.port)
  await e.init()
  await e.syncCloud()
  assert.equal(e.getSnapshot().error, null)
  assert.equal(summary.uploaded, 8)
  assert.equal(updates, 8)
  assert.equal(e.getSnapshot().progress?.chunksCompleted, 8)
  assert.equal(f.data.get('record:parallel'), original)
  e.dispose()
})
