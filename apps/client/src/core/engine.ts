import {
  NotionStore,
  notionId,
  validateManifest,
  type AudioManifest,
  type RemoteRecording,
} from '@uomi/notion'
import { oggOpus, oggFrames } from './playback'
import {
  recordIndex,
  cooperativePlans,
  frameId,
  silenceFrames,
  type RecordIndex,
  type ChunkPlan,
  type PlanningProgress,
  planningLabel,
} from './catalog'
import { forEachBounded, runPipeline, type PipelineProgress } from './pipeline'
import { reconciliationQueries } from './notion-sync'
import type { AudioSegment } from './segments'
import { LiveAssembler } from './live'
import { Buffer } from 'buffer'
import {
  defaults,
  validateSettings,
  type Port,
  type Settings,
  type Snapshot,
  type Device,
  type Recording,
  type Frame,
  type SyncProgress,
} from './types'
import {
  UUID,
  parseInfo,
  readCommand,
  parseRecord,
  opusDuration,
  RecordAssembler,
} from './protocol'
import { periodicDue, segments } from './segments'

export class Engine {
  private liveUnsubscribe: (() => Promise<void>) | undefined
  private cancelDownload: (() => void) | undefined
  private syncReason: 'manual' | 'realtime' | 'periodic' = 'manual'
  private deadline = Infinity
  private pairing = false
  private monitoring = false
  private monitorGeneration = 0
  private monitorUnsubscribe: (() => Promise<void>) | undefined
  async startMonitor(onFrame: (frame: Frame) => void): Promise<void> {
    if (this.snapshot.busy || this.pairing || this.monitoring)
      throw Error('Wait for the current device operation to finish.')
    if (!this.snapshot.settings.deviceAddress) throw Error('Connect an Omi first.')
    this.monitoring = true
    const generation = ++this.monitorGeneration
    const assembler = new LiveAssembler()
    try {
      await this.closeLink()
      await this.port.connect(this.snapshot.settings.deviceAddress)
      await this.identify(this.snapshot.settings.deviceAddress)
      if (generation !== this.monitorGeneration) throw Error('Live monitor stopped.')
      const unsubscribe = await this.port.subscribe(UUID.omi, UUID.audio, (data) => {
        if (generation !== this.monitorGeneration) return
        try {
          const frame = assembler.push(Buffer.from(data, 'base64'))
          if (frame) onFrame(frame)
        } catch {
          /* Discard malformed live packets; never persist debug audio. */
        }
      })
      if (generation !== this.monitorGeneration) {
        await unsubscribe()
        throw Error('Live monitor stopped.')
      }
      this.monitorUnsubscribe = unsubscribe
    } catch (error) {
      if (generation === this.monitorGeneration) await this.stopMonitor()
      else if (!this.monitoring) await this.port.disconnect()
      throw error
    }
  }
  async stopMonitor() {
    this.monitorGeneration++
    if (!this.monitoring) return
    const unsubscribe = this.monitorUnsubscribe
    this.monitorUnsubscribe = undefined
    try {
      await unsubscribe?.()
    } finally {
      try {
        await this.port.disconnect()
      } finally {
        this.monitoring = false
      }
    }
  }
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private active = false
  private snapshot: Snapshot = {
    remoteRecordings: [],
    checkingNotion: false,
    progress: null,
    settings: { ...defaults },
    hasSecret: false,
    device: null,
    recordings: [],
    busy: false,
    phase: 'Ready',
    error: null,
    lastSync: null,
    lastDeviceSync: null,
    wifi: false,
    droppedPackets: '0',
  }
  constructor(private port: Port) {}
  private initialization: Promise<void> | undefined
  init() {
    return (this.initialization ??= this.initialize().catch((e) => {
      this.initialization = undefined
      throw e
    }))
  }
  getSnapshot = () => this.snapshot
  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  private lastProgressNotification = 0
  private update(p: Partial<Snapshot>) {
    const previous = this.snapshot.progress
    this.snapshot = { ...this.snapshot, ...p }
    if (p.progress && Object.keys(p).every((key) => key === 'progress' || key === 'transfer')) {
      const now = Date.now()
      // Persistence continues for every packet; only paint notifications are
      // throttled. Always publish stage changes and terminal progress.
      if (
        previous?.stage === p.progress.stage &&
        previous.detail === p.progress.detail &&
        p.progress.completed < p.progress.total &&
        now - this.lastProgressNotification < 150
      )
        return
      this.lastProgressNotification = now
    }
    this.listeners.forEach((f) => f())
  }
  private async initialize() {
    const saved = await this.port.get('settings')
    const lastSync = await this.port.get('lastSync')
    const lastDeviceSync = await this.port.get('lastDeviceSync')
    let hasSecret = false
    let keyringError: string | null = null
    try {
      hasSecret = !!(await this.port.secret())
    } catch (e) {
      keyringError = e instanceof Error ? e.message : String(e)
    }
    this.update({
      settings: saved ? { ...defaults, ...JSON.parse(saved) } : defaults,
      lastSync,
      lastDeviceSync,
      hasSecret,
      error: keyringError,
      wifi: await this.port.wifi(),
    })
    await this.refresh()
    try {
      await this.port.schedule(this.snapshot.settings)
    } catch (e) {
      this.update({ error: e instanceof Error ? e.message : String(e) })
    }
    this.arm()
    // Bounded, transactional migration runs after the library is usable. The native
    // store accepts both formats throughout; no full-history JSON crosses JS.
    if (this.active && this.port.optimizeAudio) void this.optimizeAudio()
  }
  private optimizingAudio = false
  private disposed = false
  private async optimizeAudio() {
    if (this.optimizingAudio || this.disposed) return
    this.optimizingAudio = true
    try {
      while (this.active && !this.disposed) {
        if (this.snapshot.busy) {
          await new Promise<void>((resolve) => setTimeout(resolve, 500))
          continue
        }
        if (!(await this.port.optimizeAudio!())) break
        await new Promise<void>((resolve) => setTimeout(resolve, 100))
      }
    } catch {
      this.update({
        storageMigrationError:
          'Storage optimization paused. Existing recordings remain readable; restart to retry.',
      })
    } finally {
      this.optimizingAudio = false
    }
  }
  private refreshGeneration = 0
  async refresh(report?: (value: SyncProgress) => void) {
    const generation = ++this.refreshGeneration
    const recordings: Recording[] = []
    const catalog: RecordIndex[] = []
    const target = this.notionTarget()
    if (this.port.catalogEntries) {
      let after = ''
      for (;;) {
        const entries = await this.port.catalogEntries(after)
        if (generation !== this.refreshGeneration) return
        if (!entries.length) break
        for (const { value } of entries) {
          const record: RecordIndex = JSON.parse(value)
          if (this.port.notion && record.notionTarget !== target) record.uploaded = 0
          catalog.push(record)
        }
        const next = entries.at(-1)!.key
        if (next <= after) throw Error('Recording catalog did not advance.')
        after = next
        this.update({ loadingRecords: catalog.length })
        report?.({
          stage: 'prepare',
          completed: catalog.length,
          total: 0,
          unit: 'recordings',
          detail: 'Reading local recording index',
        })
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
    } else
      for await (const value of this.storedValues('record:')) {
        if (generation !== this.refreshGeneration) return
        const record: Recording = JSON.parse(value)
        if (this.port.notion && record.notionTarget !== target) record.uploaded = 0
        recordings.push(record)
        if (recordings.length % 256 === 0)
          report?.({
            stage: 'prepare',
            completed: recordings.length,
            total: 0,
            unit: 'recordings',
            detail: 'Reading local recording index',
          })
      }
    report?.({
      stage: 'prepare',
      completed: catalog.length || recordings.length,
      total: catalog.length || recordings.length,
      unit: 'recordings',
      detail: 'Local recording index loaded',
    })
    recordings.sort(
      (a, b) =>
        a.deviceId.localeCompare(b.deviceId) ||
        (BigInt(a.sequence) < BigInt(b.sequence)
          ? -1
          : BigInt(a.sequence) > BigInt(b.sequence)
            ? 1
            : 0),
    )
    const remoteRecordings: RemoteRecording[] = []
    if (!this.port.mirrorEntries)
      for await (const value of this.storedValues('notion:remote:')) {
        if (value) {
          const remote = JSON.parse(value)
          if (remote.target === this.notionTarget()) remoteRecordings.push(remote)
        }
      }
    if (generation !== this.refreshGeneration) return
    const localPlans = this.port.catalogEntries
      ? await (this.port.planAudio ?? cooperativePlans)(
          catalog,
          this.snapshot.settings.segmentSeconds,
          false,
          report ? (value) => report({ stage: 'prepare', ...this.planProgress(value) }) : undefined,
        )
      : undefined
    const wifi = await this.port.wifi()
    if (generation !== this.refreshGeneration) return
    this.update({
      localPlans,
      recordings,
      catalog: this.port.catalogEntries ? catalog : undefined,
      remoteRecordings,
      loadingRecords: undefined,
      wifi,
    })
    if (this.port.mirrorEntries && this.snapshot.settings.notionSource && this.snapshot.hasSecret)
      await this.refreshRemote()
  }
  private async *storedValues(prefix: string) {
    if (!this.port.entries) {
      for (const key of await this.port.list(prefix)) {
        const value = await this.port.get(key)
        if (value) yield value
      }
      return
    }
    let after = ''
    let count = 0
    for (;;) {
      const page = await this.port.entries(prefix, after)
      if (!page.length) break
      for (const entry of page) yield entry.value
      const next = page[page.length - 1].key
      if (next <= after) throw Error('Storage pagination did not advance.')
      after = next
      count += page.length
      if (prefix === 'record:') {
        this.update({ loadingRecords: count })
        if (this.snapshot.busy && this.snapshot.progress?.stage === 'prepare')
          this.update({
            progress: {
              stage: 'prepare',
              completed: count,
              total: 0,
              detail: 'Loading local recordings',
            },
          })
      }
      // Let the WebView paint and handle input between bounded native reads.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }
  private planProgress(value: PlanningProgress) {
    return {
      completed: value.completed,
      total: value.total,
      unit: value.phase === 'merging' ? 'index entries' : 'recordings',
      detail: planningLabel[value.phase],
      plannedChunks: value.chunks,
    }
  }
  private inventory(): RecordIndex[] {
    return this.snapshot.catalog ?? this.snapshot.recordings.map(recordIndex)
  }
  private async writeBatch(puts: { key: string; value: string }[], removes: string[] = []) {
    if (this.port.batch) {
      await this.port.batch(puts, removes)
      return
    }
    // Preserve ordering in adapters without native transactions: tombstones and
    // acknowledgements must be durable before removing any original record.
    for (const { key, value } of puts) await this.port.put(key, value)
    for (const key of removes) await this.port.remove(key)
  }
  private async readMany(keys: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    for (let start = 0; start < keys.length; start += 256) {
      const batch = keys.slice(start, start + 256)
      if (this.port.getMany)
        for (const entry of await this.port.getMany(batch)) result.set(entry.key, entry.value)
      else
        for (const key of batch) {
          const value = await this.port.get(key)
          if (value !== null) result.set(key, value)
        }
    }
    return result
  }
  async loadLocalChunk(plan: ChunkPlan): Promise<AudioSegment['frames']> {
    const values = await this.readMany([...new Set(plan.ranges.map((range) => range.key))])
    const frames: AudioSegment['frames'] = []
    for (const range of plan.ranges) {
      const raw = values.get(range.key)
      if (!raw) throw Error('This local audio is no longer available. Its saved copy is in Notion.')
      const record: Recording = JSON.parse(raw)
      frames.push(...silenceFrames(range.gapMs, `${range.key}:${range.from}`))
      for (let i = range.from; i < range.to; i++) {
        const frame = record.frames[i]
        if (!frame) throw Error('Local audio changed while reading the chunk.')
        frames.push({
          ...frame,
          capturedAt: record.capturedAt
            ? new Date(Date.parse(record.capturedAt) + frame.offsetMs).toISOString()
            : null,
          recordTimestamp: record.timestampRaw,
          timing: record.timing,
          sequence: record.sequence,
          ringId: record.ringId,
        })
      }
    }
    return frames
  }
  async save(settings: Settings, secret?: string, transcriberSecret?: string) {
    if (this.monitoring) throw Error('Stop live monitoring before changing settings.')
    this.storeCache = undefined
    this.lastMirrorRun = 0
    validateSettings(settings)
    if (transcriberSecret !== undefined && transcriberSecret.length < 24)
      throw Error('Use a transcriber webhook secret of at least 24 characters.')
    if (
      settings.transcriberEndpoint &&
      this.port.transcriberSecret &&
      !(transcriberSecret ?? (await this.port.transcriberSecret()))
    )
      throw Error('Set a transcriber webhook secret before enabling notifications.')
    if (secret !== undefined && /[\r\n]/.test(secret))
      throw Error('The secret cannot contain line breaks.')
    const hasSecretAfter = secret === undefined ? this.snapshot.hasSecret : secret.length > 0
    if (settings.mode !== 'manual' && !hasSecretAfter)
      throw Error('Set a Notion token before enabling automatic sync.')
    if (this.snapshot.busy) throw Error('Wait for the current sync before changing settings.')
    if (settings.notionSource) notionId(settings.notionSource)
    if (transcriberSecret !== undefined) await this.port.transcriberSecret?.(transcriberSecret)
    if (secret !== undefined) await this.port.secret(secret)
    const previous = this.snapshot.settings
    await this.port.put('settings', JSON.stringify(settings))
    this.update({ settings })
    try {
      await this.port.schedule(settings)
    } catch (e) {
      await this.port.put('settings', JSON.stringify(previous))
      this.update({ settings: previous })
      try {
        await this.port.schedule(previous)
      } catch {}
      throw e
    }
    this.update({
      settings,
      hasSecret: hasSecretAfter,
      error: null,
    })
    if (settings.mode !== 'realtime') {
      await this.closeLink()
    }
    this.arm()
  }
  async scan(): Promise<Device[]> {
    if (this.snapshot.busy || this.monitoring)
      throw Error('Stop live monitoring and wait for the current sync to finish.')
    return this.port.scan()
  }
  async pair(device: Device) {
    if (this.snapshot.busy || this.monitoring)
      throw Error('Stop live monitoring and wait for the current sync to finish.')
    this.pairing = true
    try {
      await this.port.connect(device.address)
      const details = await this.identify(device.address, device.name)
      await this.save({
        ...this.snapshot.settings,
        deviceAddress: device.address,
      })
      this.update({ device: details })
    } finally {
      await this.port.disconnect()
      this.pairing = false
    }
  }
  async unpair() {
    if (this.snapshot.busy || this.monitoring)
      throw Error('Stop live monitoring and wait for the current sync to finish.')
    await this.save({
      ...this.snapshot.settings,
      deviceAddress: '',
      mode: 'manual',
    })
    this.update({ device: null })
  }
  async micGain(level?: number): Promise<number> {
    if (level !== undefined && (!Number.isInteger(level) || level < 0 || level > 8))
      throw Error('Microphone gain must be a level from 0 to 8.')
    if (this.snapshot.busy || this.pairing)
      throw Error('Wait for the current device operation to finish.')
    const address = this.snapshot.settings.deviceAddress
    if (!address) throw Error('Connect an Omi first.')
    this.update({ busy: true })
    try {
      if (!this.monitoring) await this.port.connect(address)
      // Read before writing so unsupported firmware is never changed blindly.
      const read = async () => {
        const value = Buffer.from(await this.port.read(UUID.settings, UUID.micGain), 'base64')
        if (value.length !== 1 || value[0] > 8)
          throw Error('This device does not expose the supported 0–8 microphone gain control.')
        return value[0]
      }
      let actual = await read()
      if (level !== undefined) {
        await this.port.write(UUID.settings, UUID.micGain, Buffer.from([level]).toString('base64'))
        actual = await read()
        if (actual !== level)
          throw Error(
            `Omi reported gain level ${actual} after requesting ${level}. Read the device setting again.`,
          )
      }
      this.update({
        device: {
          ...(this.snapshot.device ?? { address, name: 'Omi' }),
          micGain: actual,
        },
      })
      return actual
    } finally {
      try {
        if (!this.monitoring) await this.closeLink()
      } finally {
        this.update({ busy: false })
      }
    }
  }
  private async identify(address: string, name = 'Omi'): Promise<Device> {
    // Serial Number String is optional on Omi, including stock consumer builds.
    // Normalize BlueZ adapter paths and Android MACs to the same identity.
    let serial = ''
    try {
      serial = Buffer.from(await this.port.read(UUID.info, UUID.serial), 'base64')
        .toString('utf8')
        .replace(/\0/g, '')
        .trim()
    } catch {
      // Missing optional DIS metadata must not prevent pairing.
    }
    if (!serial || /^(unknown|0+|f{16})$/i.test(serial)) {
      const mac =
        address.match(/(?:^|\/)dev_([0-9a-f]{2}(?:_[0-9a-f]{2}){5})$/i)?.[1].replace(/_/g, ':') ??
        address
      if (!/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i.test(mac))
        throw Error(
          'This device has no serial number or usable Bluetooth address for multi-client identification.',
        )
      serial = `ble:${mac.toUpperCase()}`
    }
    const firmware = Buffer.from(await this.port.read(UUID.info, UUID.firmware), 'base64')
      .toString('utf8')
      .replace(/\0/g, '')
      .trim()
    const version = firmware.split('.').map(Number)
    if (
      version.length < 3 ||
      !version.every(Number.isFinite) ||
      version[0] < 3 ||
      (version[0] === 3 && version[1] === 0 && version[2] < 20)
    )
      throw Error(
        `Firmware ${firmware} is unsupported. Uomi requires Omi ring-storage firmware 3.0.20 or later.`,
      )
    const codec = Buffer.from(await this.port.read(UUID.omi, UUID.codec), 'base64')[0]
    if (codec !== 20 && codec !== 21)
      throw Error('This device must record Opus audio (codec 20 or 21).')
    let battery: number | undefined
    try {
      battery = Buffer.from(await this.port.read(UUID.batteryService, UUID.battery), 'base64')[0]
    } catch {}
    let micGain: number | undefined
    try {
      const value = Buffer.from(await this.port.read(UUID.settings, UUID.micGain), 'base64')
      if (value.length === 1 && value[0] <= 8) micGain = value[0]
    } catch {
      /* Optional device control; recording sync must still work. */
    }
    return { address, name, serial, firmware, battery, micGain }
  }
  async importDevice() {
    if (!this.snapshot.settings.deviceAddress)
      throw Error('Pair an Omi before importing recordings.')
    return this.sync('manual', 'device')
  }
  async syncNotion() {
    await this.sync('manual', 'notion')
    if (!this.snapshot.error) await this.refreshNotion()
  }
  async sync(
    reason: 'manual' | 'realtime' | 'periodic' = 'manual',
    scope: 'all' | 'device' | 'notion' = 'all',
  ) {
    if (this.snapshot.busy || this.snapshot.checkingNotion || this.pairing || this.monitoring)
      return
    const s = this.snapshot.settings
    if (
      (reason === 'realtime' && s.mode !== 'realtime') ||
      (reason === 'periodic' && s.mode !== 'periodic')
    )
      return
    if (
      reason === 'periodic' &&
      (!(await this.port.wifi()) || !periodicDue(this.snapshot.lastSync, s.intervalHours))
    )
      return
    this.syncReason = reason
    this.deadline = reason === 'periodic' ? Date.now() + 6 * 60000 : Infinity
    this.update({
      busy: true,
      error: null,
      progress: null,
      phase:
        scope === 'device'
          ? 'Preparing Omi import'
          : scope === 'notion'
            ? 'Preparing Notion sync'
            : 'Preparing sync',
    })
    let syncFailed = false
    try {
      // Explicit manual actions are isolated; scheduled sync still runs both stages.
      if (scope !== 'device') {
        if (scope === 'notion') {
          this.update({
            progress: {
              stage: 'prepare',
              completed: 0,
              total: 0,
              detail: 'Checking Notion database configuration',
            },
          })
          await this.notionStore().setup()
        }
        try {
          await this.upload()
        } catch (e) {
          if (scope === 'notion' || !s.deviceAddress) throw e
        }
      }
      if (scope !== 'notion' && s.deviceAddress) {
        await this.port.connect(s.deviceAddress)
        const device = await this.identify(s.deviceAddress)
        this.update({ device, phase: 'Saving device recordings' })
        await this.download(device)
        await this.refresh()
        const lastDeviceSync = new Date().toISOString()
        await this.port.put('lastDeviceSync', lastDeviceSync)
        this.update({ lastDeviceSync, progress: null })
        if (scope === 'all') await this.upload()
      }
      if (scope !== 'device') {
        await this.port.put('lastSync', new Date().toISOString())
        this.update({ lastSync: await this.port.get('lastSync') })
      }
      this.update({
        phase: scope === 'device' ? 'Omi recordings saved locally' : 'Notion is up to date',
      })
    } catch (e) {
      syncFailed = true
      if (scope !== 'notion') {
        try {
          await this.liveUnsubscribe?.()
        } catch {}
        this.liveUnsubscribe = undefined
        try {
          await this.port.disconnect()
        } catch {}
      }
      this.update({
        error: e instanceof Error ? e.message : String(e),
        phase: 'Sync paused — recordings are kept locally',
        progress: null,
      })
    } finally {
      try {
        if (scope !== 'notion' && (s.mode !== 'realtime' || !this.liveUnsubscribe))
          await this.closeLink()
      } catch {}
      if (syncFailed && scope === 'notion') {
        // The pipeline has drained before reaching here. A read-only catalog
        // rebuild must not keep Retry/Settings disabled after the failure.
        this.update({ busy: false, progress: null })
        const originalError = this.snapshot.error
        void this.refresh().catch(() => {
          // Preserve the actionable upload error; the next sync refreshes again.
          if (!this.snapshot.busy && this.snapshot.error === originalError)
            this.update({ loadingRecords: undefined })
        })
      } else {
        try {
          await this.refresh()
        } catch (e) {
          if (!this.snapshot.error)
            this.update({ error: e instanceof Error ? e.message : String(e) })
        }
        this.update({ busy: false, progress: null })
      }
    }
  }
  private async download(device: Device) {
    let infoWait: ((b: Buffer) => void) | undefined
    let rejectWait: ((e: Error) => void) | undefined
    let ackWait: ((b: Buffer) => void) | undefined
    let transfer: ((b: Buffer) => void) | undefined
    const unsubscribe = await this.port.subscribe(UUID.storage, UUID.control, (data) => {
      const b = Buffer.from(data, 'base64')
      if (b[0] === 2) infoWait?.(b)
      else if (b[0] === 1) ackWait?.(b)
      else transfer?.(b)
    })
    try {
      const infoPromise = new Promise<Buffer>((resolve, reject) => {
        infoWait = resolve
        rejectWait = reject
      })
      this.cancelDownload = () =>
        rejectWait?.(Error('Sync paused because the app left the foreground.'))
      const infoTimeout = setTimeout(
        () => rejectWait?.(Error('The device did not return ring storage information.')),
        10000,
      )
      let info
      try {
        await this.port.write(UUID.storage, UUID.control, Buffer.from([0x10]).toString('base64'))
        info = parseInfo(await infoPromise)
      } finally {
        clearTimeout(infoTimeout)
        infoWait = undefined
      }
      this.update({ droppedPackets: info.dropped.toString() })
      const retainsConnectedAudio = info.contract === 1 && (info.caps & 3) === 3
      if (retainsConnectedAudio) {
        const ack = new Promise<Buffer>((resolve, reject) => {
          ackWait = resolve
          rejectWait = reject
        })
        const ackTimeout = setTimeout(
          () => rejectWait?.(Error('The device did not confirm safe recording retention.')),
          10000,
        )
        try {
          await this.port.write(
            UUID.storage,
            UUID.control,
            Buffer.from([0x14, 1, info.caps & 0x0f]).toString('base64'),
          )
          const response = await ack
          if (response.length < 3 || response[1] !== 0 || (response[2] & 3) !== 3)
            throw Error(
              'The device refused safe recording retention. No audio was read or reclaimed.',
            )
        } finally {
          clearTimeout(ackTimeout)
          ackWait = undefined
        }
        // Subscribe only after the device promises to persist connected audio to its ring.
        // The live transport is intentionally ignored: canonical audio comes from ring records.
        if (!this.liveUnsubscribe)
          this.liveUnsubscribe = await this.port.subscribe(UUID.omi, UUID.audio, () => {})
      } else {
        // Stock firmware reclaims BLE-delivered records automatically. It also
        // does not persist connected live audio, so return to offline recording
        // after each import instead of leaving a silent live subscription open.
        await this.liveUnsubscribe?.()
        this.liveUnsubscribe = undefined
      }

      // Never explicitly ADVANCE, CLEAR or DELETE. Stock firmware may auto-advance.
      // A content digest identifies packets even on firmware without a persistent ring ID.
      const cursorKey = `cursor:${device.serial}:${info.ringId ?? 'legacy'}`
      // Without a persistent ring ID, a reboot can reuse sequence numbers.
      // Replay the available range and deduplicate by packet content instead
      // of trusting a cursor from an unknown ring incarnation.
      const saved = info.ringId !== null ? await this.port.get(cursorKey) : null
      let start = saved ? BigInt(saved) : info.read
      if (start < info.read || start > info.write) start = info.read
      const importStart = start
      const importTotal = Number(info.write - start)
      this.update({
        progress: { stage: 'import', completed: 0, total: importTotal },
        transfer: undefined,
      })
      let transferElapsed = 0
      let transferStorage = 0
      let transferBytes = 0
      let transferLargest = 0
      while (start < info.write) {
        if (this.syncReason === 'periodic' && !(await this.port.wifi()))
          throw Error('Wi-Fi disconnected. Sync is paused until Wi-Fi returns.')
        if (Date.now() > this.deadline)
          throw Error(
            'Sync paused at its background time limit. Saved progress will resume on the next job.',
          )
        if (this.port.importRing) {
          // Bound admission to 444 KiB of ring data, while the native receiver
          // overlaps reception with 32-packet FULL-sync SQLite transactions.
          const count = Number(info.write - start > 1024n ? 1024n : info.write - start)
          const baseline = Number(start - importStart)
          const requestId = `${Date.now()}:${start}:${Math.random().toString(36).slice(2)}`
          this.cancelDownload = () => {
            void this.port.cancelImport?.(requestId).catch(() => {})
          }
          const progress = (metrics: import('./types').ImportMetrics) => {
            this.update({
              progress: {
                stage: 'import',
                completed: baseline + metrics.completed,
                total: importTotal,
              },
              transfer: {
                ...metrics,
                completed: baseline + metrics.completed,
                elapsedMs: transferElapsed + metrics.elapsedMs,
                storageMs: transferStorage + metrics.storageMs,
                receivedBytes: transferBytes + metrics.receivedBytes,
                maxNotificationBytes: Math.max(transferLargest, metrics.maxNotificationBytes),
              },
            })
          }
          const result = await this.port.importRing(
            {
              id: requestId,
              start: start.toString(),
              count,
              deviceId: device.serial!,
              ringId: info.ringId?.toString() ?? null,
              cursorKey,
              finalRange: start + BigInt(count) === info.write,
            },
            progress,
          )
          if (result.completed !== count)
            throw Error('Incomplete native import. Committed audio is retained.')
          progress(result)
          transferElapsed += result.elapsedMs
          transferStorage += result.storageMs
          transferBytes += result.receivedBytes
          transferLargest = Math.max(transferLargest, result.maxNotificationBytes)
          start += BigInt(count)
          continue
        }
        const count = Number(info.write - start > 128n ? 128n : info.write - start)
        const end = start + BigInt(count)
        const assembler = new RecordAssembler()
        let sequence = start
        let begun = false
        let processing = Promise.resolve()
        let failure: Error | undefined
        let doneResolve: (() => void) | undefined
        let doneReject: ((e: Error) => void) | undefined
        const done = new Promise<void>((resolve, reject) => {
          doneResolve = resolve
          doneReject = reject
        })
        this.cancelDownload = () =>
          doneReject?.(Error('Sync paused because the app left the foreground.'))
        const timeout = setTimeout(
          () => doneReject?.(Error('Bluetooth transfer timed out. Sync again to resume.')),
          60000,
        )
        transfer = (b) => {
          try {
            if (b[0] === 5) {
              if (
                b.length < 13 ||
                begun ||
                b.readBigUInt64BE(1) !== start ||
                b.readUInt32BE(9) !== count
              )
                throw Error('The device recording range changed. Sync again to resume.')
              begun = true
            } else if (b[0] === 3) {
              if (!begun) throw Error('Received audio before its transfer range.')
              for (const record of assembler.push(b.subarray(1))) {
                const seq = sequence++
                if (seq >= end) throw Error('Device sent more audio than requested.')
                processing = processing.then(async () => {
                  if (failure) return
                  try {
                    await this.persistRecord(device, info.ringId, seq, record, cursorKey)
                    this.update({
                      progress: {
                        stage: 'import',
                        completed: Number(seq + 1n - importStart),
                        total: importTotal,
                      },
                    })
                  } catch (e) {
                    failure = e instanceof Error ? e : Error(String(e))
                  }
                })
              }
            } else if (b[0] === 4) {
              if (
                b.length < 10 ||
                b[1] !== 0 ||
                b.readBigUInt64BE(2) !== end ||
                sequence !== end ||
                assembler.remaining !== 0 ||
                !begun
              )
                throw Error(
                  'Incomplete Bluetooth transfer. Stored audio is safe; sync again to resume.',
                )
              doneResolve?.()
            }
          } catch (e) {
            doneReject?.(e instanceof Error ? e : Error(String(e)))
          }
        }
        try {
          await this.port.write(
            UUID.storage,
            UUID.control,
            readCommand(start, count).toString('base64'),
          )
          await done
        } finally {
          clearTimeout(timeout)
          transfer = undefined
          await processing
        }
        if (failure) throw failure
        start = end
      }
      // Set RTC for future captures only after preserving the timestamps of existing data.
      const clock = Buffer.alloc(4)
      clock.writeUInt32LE(Math.floor(Date.now() / 1000))
      await this.port.write(UUID.time, UUID.clock, clock.toString('base64'))
    } finally {
      this.cancelDownload = undefined
      try {
        await this.port.write(UUID.storage, UUID.control, Buffer.from([3]).toString('base64'))
      } catch {}
      await unsubscribe()
    }
  }
  private async persistRecord(
    device: Device,
    ringId: bigint | null,
    sequence: bigint,
    bytes: Buffer,
    cursorKey: string,
  ) {
    const digest = await this.port.hash(
      Buffer.concat([Buffer.from(`${ringId ?? 'legacy'}:${sequence}:`), bytes]).toString('base64'),
    )
    const key = `record:${encodeURIComponent(device.serial!)}:${digest}`
    if ((await this.port.get(key)) || (await this.port.get(`seen:${key}`))) {
      await this.port.put(cursorKey, (sequence + 1n).toString())
      return
    }
    const parsed = parseRecord(bytes)
    let offsetMs = 0
    const frames = parsed.frames.map((frame, i) => {
      const durationMs = opusDuration(frame)
      const f = {
        id: `${device.serial}:${digest}:${i}`,
        data: frame.toString('base64'),
        durationMs,
        offsetMs,
      }
      offsetMs += durationMs
      return f
    })
    const utc = (parsed.timestampRaw & 0x80000000) === 0 && parsed.timestampRaw > 0
    const record: Recording = {
      key,
      deviceId: device.serial!,
      ringId: ringId?.toString() ?? null,
      sequence: sequence.toString(),
      capturedAt: utc ? new Date(parsed.timestampRaw * 1000).toISOString() : null,
      timestampRaw: parsed.timestampRaw,
      timing: utc ? 'device-utc' : 'device-uptime',
      frames,
      uploaded: 0,
      bytes: bytes.length,
      receivedAt: new Date().toISOString(),
    }
    await this.writeBatch([
      { key, value: JSON.stringify(record) },
      { key: cursorKey, value: (sequence + 1n).toString() },
    ])
  }
  private async upload() {
    if (this.port.notion) return this.uploadNotion()
    await this.refresh()
    const records = this.snapshot.recordings.filter((r) => r.uploaded < r.frames.length)
    if (!records.length) return
    const s = this.snapshot.settings
    if (!s.endpoint || !this.snapshot.hasSecret)
      throw Error('Audio is saved locally. Add a webhook URL and secret in Settings to send it.')
    const totalFrames = records.reduce((n, r) => n + r.frames.length - r.uploaded, 0)
    let sentFrames = 0
    this.update({
      progress: { stage: 'upload', completed: 0, total: totalFrames },
    })
    for (const segment of segments(this.snapshot.recordings, s.segmentSeconds)) {
      if (this.syncReason === 'periodic' && !(await this.port.wifi()))
        throw Error('Wi-Fi disconnected. Sync is paused until Wi-Fi returns.')
      if (Date.now() > this.deadline)
        throw Error('Sync paused at its background time limit. Audio stays queued.')
      this.update({
        phase: `Sending ${(segment.durationMs / 1000).toFixed(1)} seconds of audio`,
      })
      const id = await this.port.hash(
        Buffer.from(JSON.stringify(segment.frames.map((f) => f.id))).toString('base64'),
      )
      await this.port.post(
        s.endpoint,
        s.secretHeader,
        JSON.stringify({ ...segment, segmentId: id }),
        s.compression,
        id,
      )
      const accepted = new Set(segment.frames.map((f) => f.id))
      for (const r of records) {
        let uploaded = r.uploaded
        while (uploaded < r.frames.length && accepted.has(r.frames[uploaded].id)) uploaded++
        if (uploaded !== r.uploaded) {
          r.uploaded = uploaded
          await this.port.put(r.key, JSON.stringify(r))
        }
      }
      sentFrames += segment.frames.length
      this.update({
        progress: {
          stage: 'upload',
          completed: sentFrames,
          total: totalFrames,
        },
      })
    }
  }
  private notionTarget() {
    const source = this.snapshot.settings.notionSource
    return source ? notionId(source) : 'unconfigured'
  }
  private storeCache?: { target: string; store: NotionStore }
  private notionStore() {
    if (!this.port.notion || !this.snapshot.settings.notionSource || !this.snapshot.hasSecret)
      throw Error('Audio is kept locally. Add a Notion token and database in Settings to sync.')
    const target = this.notionTarget()
    if (this.storeCache?.target !== target)
      this.storeCache = {
        target,
        store: new NotionStore(this.port.notion, this.snapshot.settings.notionSource),
      }
    return this.storeCache.store
  }
  private lastMirrorRun = 0
  private async syncMirror(store: NotionStore, force = false) {
    if (!force && Date.now() - this.lastMirrorRun < 1000) return
    const target = this.notionTarget()
    const cursorKey = `notion:mirror-cursor:${target}`
    const cursor = await this.port.get(cursorKey)
    let watermark = Number(cursor ?? 0)
    const filter = cursor
      ? {
          timestamp: 'last_edited_time',
          last_edited_time: {
            on_or_after: new Date(Math.max(0, Number(cursor) - 120000)).toISOString(),
          },
        }
      : undefined
    let count = 0
    for await (const pages of store.queryPages(filter)) {
      for (const page of pages) {
        const edited = Date.parse(page.last_edited_time ?? page.created_time ?? '')
        if (Number.isFinite(edited)) watermark = Math.max(watermark, edited)
      }
      const puts = pages.map((page) => ({
        key: `notion:page:${target}:${page.id}`,
        value: JSON.stringify(page),
      }))
      if (puts.length) await this.writeBatch(puts)
      count += pages.length
      this.update({
        progress: {
          stage: 'refresh',
          completed: count,
          total: 0,
          unit: 'pages',
          detail: cursor ? 'Reading changed Notion recordings' : 'Building Notion recording index',
        },
      })
    }
    if (cursor)
      for await (const pages of store.queryPages(filter, true)) {
        const removes: string[] = []
        for (const page of pages) {
          removes.push(`notion:page:${target}:${page.id}`)
          const id = (page.properties['Recording ID']?.rich_text ?? [])
            .map((v: any) => v.plain_text ?? v.text?.content ?? '')
            .join('')
          if (id) removes.push(`notion:remote:${target}:${id}`)
        }
        if (removes.length) await this.writeBatch([], removes)
      }
    await this.port.put(cursorKey, String(watermark))
    this.lastMirrorRun = Date.now()
  }
  private async *mirrorPages(query: { devices?: string[]; from?: number; until?: number } = {}) {
    const target = this.notionTarget()
    if (this.port.mirrorEntries) {
      let offset = 0
      for (;;) {
        const values = await this.port.mirrorEntries({ target, ...query, limit: 100, offset })
        if (!values.length) break
        for (const value of values) yield JSON.parse(value)
        offset += values.length
      }
    } else
      for await (const value of this.storedValues(`notion:page:${target}:`)) {
        const page = JSON.parse(value)
        const remote = this.notionStore().remotePage(page, target)
        if (query.devices && !query.devices.includes(remote.deviceId)) continue
        const start = Date.parse(remote.capturedAt ?? '')
        if (
          Number.isFinite(start) &&
          query.from !== undefined &&
          start + remote.durationMs < query.from
        )
          continue
        if (Number.isFinite(start) && query.until !== undefined && start > query.until) continue
        yield page
      }
  }
  private async *matchingMirrorPages(queries: ReturnType<typeof reconciliationQueries>) {
    const seen = new Set<string>()
    for (const query of queries)
      for await (const page of this.mirrorPages(query)) {
        if (seen.has(page.id)) continue
        seen.add(page.id)
        yield page
      }
  }
  private manifestSignature(page: any) {
    return ['Audio', 'Manifest']
      .map((property) => {
        const file = page.properties[property]?.files?.[0]
        if (!file) return ''
        const url = file.file?.url ?? file.external?.url ?? ''
        try {
          return `${file.name}:${new URL(url).pathname}`
        } catch {
          return `${file.name}:${url}`
        }
      })
      .join('|')
  }
  private async manifestFor(store: NotionStore, page: any, force = false): Promise<AudioManifest> {
    const key = `notion:manifest:${this.notionTarget()}:${page.id}`
    const signature = this.manifestSignature(page)
    const cached = await this.port.get(key)
    if (!force && cached) {
      const saved = JSON.parse(cached)
      if (saved.signature === signature) {
        validateManifest(saved.manifest)
        await store.ensureSilence(page, saved.manifest)
        return saved.manifest
      }
    }
    if (!this.port.notionFile) throw Error('This app cannot read saved audio manifests.')
    let text: string
    try {
      text = await this.port.notionFile(page.id, 'Manifest', store.fileUrl(page, 'Manifest'))
    } catch {
      const fresh = await store.page(page.id)
      text = await this.port.notionFile(fresh.id, 'Manifest', store.fileUrl(fresh, 'Manifest'))
    }
    const manifest: AudioManifest = JSON.parse(text)
    validateManifest(manifest)
    await store.ensureSilence(page, manifest)
    await this.port.put(key, JSON.stringify({ signature, manifest }))
    return manifest
  }
  private async verifiedManifest(
    store: NotionStore,
    pageId: string,
    expected?: AudioManifest,
    checkSource?: (manifest: AudioManifest, audio: string) => Promise<void>,
  ) {
    if (!this.port.verifyNotionAudio)
      throw Error('This app cannot verify uploaded audio. Local audio is retained.')
    const page = await store.page(pageId)
    if (page.archived || page.in_trash)
      throw Error('The saved page is unavailable. Local audio is retained.')
    const manifest = await this.manifestFor(store, page, true)
    const fingerprint = (m: AudioManifest) =>
      JSON.stringify([
        m.id,
        m.deviceId,
        m.capturedAt,
        m.durationMs,
        m.sha256,
        m.frameIds,
        m.timing.map((t) => [
          t.sequence,
          t.ringId,
          t.timestamp,
          t.capturedAt,
          t.firstFrame,
          t.frames,
        ]),
        (m.gaps ?? []).map((g) => [g.beforeFrame, g.durationMs, g.offsetMs ?? null]),
      ])
    if (expected && fingerprint(manifest) !== fingerprint(expected))
      throw Error('Saved audio metadata differs from this upload. Local audio is retained.')
    if (checkSource) {
      if (!this.port.readNotionAudio)
        throw Error(
          'This app cannot compare saved audio with its local originals. Local audio is retained.',
        )
      const audio = await this.port.readNotionAudio(store.fileUrl(page, 'Audio'), manifest.sha256)
      await checkSource(manifest, audio)
    } else await this.port.verifyNotionAudio(store.fileUrl(page, 'Audio'), manifest.sha256)
    return { page, manifest }
  }
  private async cacheRemote(remote: RemoteRecording) {
    const key = `notion:remote:${remote.target}:${remote.id}`
    if (
      remote.notificationError === undefined &&
      ['Pending', 'Uploading', 'Failed'].includes(remote.status)
    ) {
      const existing = await this.port.get(key)
      if (existing) remote.notificationError = JSON.parse(existing).notificationError
    }
    await this.port.put(key, JSON.stringify(remote))
  }
  async refreshNotion() {
    if (this.snapshot.busy || this.snapshot.checkingNotion) return
    this.update({
      checkingNotion: true,
      phase: 'Refreshing Notion recordings',
      progress: {
        stage: 'refresh',
        completed: 0,
        total: 0,
        detail: 'Reading changed Notion recordings',
      },
    })
    try {
      const store = this.notionStore()
      await store.setup()
      await this.syncMirror(store)
      await this.refreshRemote()
    } finally {
      this.update({ checkingNotion: false, progress: null })
    }
  }
  private remoteOffset = 0
  private remoteSearch = ''
  private remoteGeneration = 0
  async moreRemote() {
    this.remoteOffset += 50
    await this.refreshRemote()
  }
  async previousRemote() {
    this.remoteOffset = Math.max(0, this.remoteOffset - 50)
    await this.refreshRemote()
  }
  async searchRemote(query: string) {
    this.remoteSearch = query.slice(0, 200)
    this.remoteOffset = 0
    await this.refreshRemote()
  }
  private async refreshRemote() {
    const generation = ++this.remoteGeneration
    const store = this.notionStore()
    const pages: any[] = []
    if (this.port.mirrorEntries) {
      for (const value of await this.port.mirrorEntries({
        target: this.notionTarget(),
        limit: 51,
        offset: this.remoteOffset,
        ...(this.remoteSearch ? { search: this.remoteSearch } : {}),
      }))
        pages.push(JSON.parse(value))
    } else {
      for await (const page of this.mirrorPages()) {
        if (
          !this.remoteSearch ||
          JSON.stringify(page).toLowerCase().includes(this.remoteSearch.toLowerCase())
        )
          pages.push(page)
      }
      pages.sort((a, b) =>
        (b.properties['Recorded at']?.date?.start ?? '').localeCompare(
          a.properties['Recorded at']?.date?.start ?? '',
        ),
      )
    }
    const visible = pages
      .slice(
        this.port.mirrorEntries ? 0 : this.remoteOffset,
        (this.port.mirrorEntries ? 0 : this.remoteOffset) + 50,
      )
      .filter(
        (page) => page.properties.Audio?.files?.length && page.properties.Manifest?.files?.length,
      )
    const remoteKeys = visible.map(
      (page) =>
        `notion:remote:${this.notionTarget()}:${store.remotePage(page, this.notionTarget()).id}`,
    )
    const savedRemotes = await this.readMany(remoteKeys)
    const remotes = visible.map((page, i) => {
      const saved = savedRemotes.get(remoteKeys[i])
      return store.remotePage(page, this.notionTarget(), saved ? JSON.parse(saved) : undefined)
    })
    if (generation !== this.remoteGeneration) return
    this.update({
      remoteRecordings: remotes,
      remoteHasPrevious: this.remoteOffset > 0,
      remotePage: Math.floor(this.remoteOffset / 50) + 1,
      remoteHasMore: this.port.mirrorEntries
        ? pages.length > 50
        : pages.length > this.remoteOffset + 50,
      ...(this.snapshot.checkingNotion
        ? {
            progress: {
              stage: 'refresh' as const,
              completed: remotes.length,
              total: remotes.length,
              detail: 'Notion recording list updated',
            },
          }
        : {}),
    })
  }
  async loadRemoteAudio(pageId: string): Promise<Frame[]> {
    if (!this.port.readNotionAudio)
      throw Error('Remote playback is unavailable in this app version.')
    const store = this.notionStore()
    const page = await store.page(pageId)
    const manifest = await this.manifestFor(store, page)
    const audio = await this.port.readNotionAudio(store.fileUrl(page, 'Audio'), manifest.sha256)
    return oggFrames(audio)
  }
  async loadTranscript(pageId: string): Promise<string> {
    const remote = this.snapshot.remoteRecordings.find((r) => r.pageId === pageId)
    if (!remote) throw Error('This recording has not been synced to this Notion destination.')
    if (!this.port.notionFile) return remote.transcript
    const result = JSON.parse(await this.port.notionFile(pageId, 'Transcript'))
    if (typeof result.text !== 'string') throw Error('Invalid transcript attachment.')
    return result.text
  }
  async retryTranscription(pageId: string) {
    const remote = this.snapshot.remoteRecordings.find((r) => r.pageId === pageId)
    if (!remote) throw Error('Unknown recording.')
    const store = this.notionStore()
    if (remote.status === 'Failed') await store.status(pageId, 'Pending')
    await this.sendNotification({
      ...remote,
      status: remote.status === 'Failed' ? 'Pending' : remote.status,
      error: remote.status === 'Failed' ? '' : remote.error,
    })
    this.lastMirrorRun = 0
    await this.refreshNotion()
  }
  private async sendNotification(remote: RemoteRecording) {
    const endpoint = this.snapshot.settings.transcriberEndpoint
    if (!endpoint || !this.port.notifyTranscriber) return
    try {
      await this.port.notifyTranscriber(endpoint, remote.pageId)
      remote.notificationError = ''
    } catch {
      remote.notificationError = 'Saved in Notion. Transcriber not reached; retry notification.'
    }
    await this.cacheRemote(remote)
  }
  private async uploadNotion() {
    this.update({
      phase: 'Preparing Notion sync',
      progress: { stage: 'prepare', completed: 0, total: 0, detail: 'Reading local audio index' },
    })
    await this.refresh((value) => this.update({ progress: value }))
    const indexes = this.inventory()
    const store = this.notionStore()
    await store.setup()
    await this.syncMirror(store, true)
    const target = this.notionTarget()
    const byKey = new Map(indexes.map((record) => [record.key, record]))
    const byPrefix = new Map<string, RecordIndex>()
    const byId = new Map<string, { record: RecordIndex; index: number }>()
    for (const [index, record] of indexes.entries()) {
      if (index % 1024 === 0) {
        this.update({
          progress: {
            stage: 'check',
            detail: 'Indexing source frame IDs',
            unit: 'recordings',
            completed: index,
            total: indexes.length,
          },
        })
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
      if (record.idPrefix) byPrefix.set(record.idPrefix, record)
      else record.frameIds?.forEach((id, index) => byId.set(id, { record, index }))
    }
    const locate = (id: string) => {
      const direct = byId.get(id)
      if (direct) return direct
      const suffix = id.match(/^(.*\D)(\d+)$/)
      const record = suffix ? byPrefix.get(suffix[1]) : undefined
      const index = Number(suffix?.[2])
      return record &&
        Number.isInteger(index) &&
        index >= 0 &&
        index < record.frameCount &&
        frameId(record, index) === id
        ? { record, index }
        : undefined
    }
    const known = new Set<string>()
    const verified = new Set<string>()
    const shouldDelete =
      this.snapshot.settings.deleteAfterUpload !== false && !!this.port.verifyNotionAudio
    const total = indexes.reduce((n, r) => n + r.frameCount - r.uploaded, 0)
    let completed = 0,
      chunksCompleted = 0
    const guard = async () => {
      if (this.syncReason === 'periodic' && !(await this.port.wifi()))
        throw Error('Wi-Fi disconnected. Local audio is retained.')
      if (Date.now() > this.deadline) throw Error('Sync paused. Local audio is retained.')
    }
    // Query disjoint candidate page-start windows per device. Unknown clocks
    // retain an unbounded device query so deduplication remains conservative.
    const matchQueries = reconciliationQueries(indexes)
    let matchingTotal = 0
    if (indexes.length && this.port.mirrorCount) {
      try {
        for (const query of matchQueries) {
          const count = await this.port.mirrorCount({ target, ...query })
          if (typeof count === 'number' && Number.isFinite(count)) matchingTotal += count
        }
      } catch {
        /* Older native backends still report completed counts. */
      }
    }
    let checked = 0
    this.update({
      progress: {
        stage: 'check',
        completed: 0,
        total: matchingTotal,
        unit: 'pages',
        detail: 'Checking matching audio manifests',
      },
    })
    await forEachBounded(this.matchingMirrorPages(matchQueries), async (page) => {
      try {
        if (!page.properties.Audio?.files?.length || !page.properties.Manifest?.files?.length)
          return
        await guard()
        this.update({
          phase: 'Checking audio saved in Notion',
          progress: {
            stage: 'check',
            completed: checked,
            total: matchingTotal,
            unit: 'pages',
            detail: 'Checking matching audio manifests',
          },
        })
        let manifest = await this.manifestFor(store, page)
        const localIds = manifest.frameIds.filter((id) => locate(id))
        if (!localIds.length) return
        if (shouldDelete) {
          this.update({
            progress: {
              stage: 'check',
              completed: checked,
              total: matchingTotal,
              unit: 'pages',
              detail: `Verifying saved audio for page ${checked + 1}`,
            },
          })
          const result = await this.verifiedManifest(
            store,
            page.id,
            manifest,
            async (saved, audio) => {
              const frames = oggFrames(audio)
              const needed = [
                ...new Set(
                  saved.frameIds
                    .map((id) => locate(id)?.record.key)
                    .filter((key): key is string => !!key),
                ),
              ]
              const sources = await this.readMany(needed)
              const records = new Map<string, Recording>()
              let cursor = 0
              let timingIndex = 0
              const gaps = new Map(
                (saved.gaps ?? []).map((gap) => [gap.beforeFrame, gap.durationMs]),
              )
              for (let i = 0; i < saved.frameIds.length; i++) {
                const gap = gaps.get(i)
                if (gap)
                  for (const silence of silenceFrames(gap, saved.frameIds[i])) {
                    if (frames[cursor++]?.data !== silence.data)
                      throw Error(
                        'Saved silence differs from its manifest. Local audio is retained.',
                      )
                  }
                const packet = frames[cursor++]
                if (!packet)
                  throw Error('Saved audio has missing source packets. Local audio is retained.')
                const local = locate(saved.frameIds[i])
                if (!local) continue
                let record = records.get(local.record.key)
                if (!record) {
                  const raw = sources.get(local.record.key)
                  if (!raw) throw Error('Cannot read original audio for verification.')
                  record = JSON.parse(raw)
                  records.set(local.record.key, record!)
                }
                while (
                  timingIndex < saved.timing.length &&
                  i >= saved.timing[timingIndex].firstFrame + saved.timing[timingIndex].frames
                )
                  timingIndex++
                const timing = saved.timing[timingIndex]
                if (
                  !timing ||
                  timing.sequence !== record!.sequence ||
                  timing.ringId !== record!.ringId ||
                  timing.timestamp !== record!.timestampRaw
                )
                  throw Error(
                    'Saved packet timing differs from its local source. Local audio is retained.',
                  )
                if (i === timing.firstFrame) {
                  const captured = record!.capturedAt
                    ? new Date(
                        Date.parse(record!.capturedAt) + record!.frames[local.index].offsetMs,
                      ).toISOString()
                    : null
                  if (
                    captured === null
                      ? timing.capturedAt !== null
                      : Date.parse(captured) !== Date.parse(timing.capturedAt ?? '')
                  )
                    throw Error(
                      'Saved capture time differs from its local source. Local audio is retained.',
                    )
                }
                if (record!.frames[local.index]?.data !== packet.data)
                  throw Error(
                    'Saved audio differs from its local source packets. Local audio is retained.',
                  )
              }
              if (cursor !== frames.length)
                throw Error('Saved audio has unexpected packets. Local audio is retained.')
            },
          )
          manifest = result.manifest
          localIds.forEach((id) => verified.add(id))
        }
        localIds.forEach((id) => known.add(id))
        if (page.properties.Status?.select?.name === 'Uploading') {
          await store.status(page.id, 'Pending')
          page.properties.Status = { select: { name: 'Pending' } }
          await this.sendNotification(store.remote(page, manifest, target))
          await this.port.put(`notion:page:${target}:${page.id}`, JSON.stringify(page))
        } else await this.cacheRemote(store.remote(page, manifest, target))
      } finally {
        checked++
        this.update({
          progress: {
            stage: 'check',
            completed: checked,
            total: matchingTotal,
            unit: 'pages',
            detail: 'Checking matching audio manifests',
          },
        })
      }
    })
    // Index-based acknowledgements and deletion use one transaction per batch.
    const acknowledged = (record: RecordIndex) => {
      let count = record.uploaded
      while (count < record.frameCount && known.has(frameId(record, count))) count++
      return count
    }
    const loaded = new Map<string, Recording>()
    const persistAcknowledgements = async (records: RecordIndex[], report = false) => {
      const changed = records.filter(
        (index) =>
          byKey.has(index.key) &&
          (acknowledged(index) !== index.uploaded ||
            (shouldDelete && index.frameCount > 0 && index.uploaded === index.frameCount)),
      )
      for (let start = 0; start < changed.length; start += 256) {
        const batch = changed.slice(start, start + 256)
        const removable = new Set(
          batch
            .filter(
              (index) =>
                shouldDelete &&
                index.frameCount > 0 &&
                acknowledged(index) === index.frameCount &&
                Array.from({ length: index.frameCount }, (_, i) => frameId(index, i)).every((id) =>
                  verified.has(id),
                ),
            )
            .map((index) => index.key),
        )
        const originals = await this.readMany(
          batch
            .filter((index) => !removable.has(index.key) && !loaded.has(index.key))
            .map((index) => index.key),
        )
        const puts: { key: string; value: string }[] = []
        const removes: string[] = []
        for (const index of batch) {
          const count = acknowledged(index)
          if (removable.has(index.key)) {
            puts.push({ key: `seen:${index.key}`, value: index.key })
            removes.push(index.key)
          } else {
            const raw =
              loaded.get(index.key) ??
              (originals.has(index.key) ? JSON.parse(originals.get(index.key)!) : undefined)
            if (!raw) throw Error('Local audio disappeared before its save was recorded.')
            raw.uploaded = count
            raw.notionTarget = target
            puts.push({ key: index.key, value: JSON.stringify(raw) })
          }
        }
        await this.writeBatch(puts, removes)
        if (report)
          this.update({
            progress: {
              stage: 'check',
              detail: 'Updating verified local copies',
              unit: 'recordings',
              completed: Math.min(start + batch.length, changed.length),
              total: changed.length,
            },
          })
        for (const index of batch) {
          index.uploaded = acknowledged(index)
          if (removable.has(index.key)) {
            byKey.delete(index.key)
            loaded.delete(index.key)
          }
        }
      }
    }
    for (const index of indexes)
      for (let i = index.uploaded; i < index.frameCount; i++)
        if (known.has(frameId(index, i))) completed++
    await persistAcknowledgements(indexes, true)
    type Checkpoint = {
      manifest: AudioManifest
      pageId: string
      audioId?: string
      metadataId?: string
    }
    type Job = {
      number: number
      plan?: ChunkPlan
      manifest?: AudioManifest
      checkpoint?: Checkpoint
      segment?: AudioSegment
      audio?: Uint8Array
      audioHashVerified?: boolean
      page?: any
      key?: string
      records: RecordIndex[]
    }
    const jobPrefix = `notion:job:${target}:`
    const checkpoints: Checkpoint[] = []
    const claimed = new Set<string>()
    this.update({
      phase: 'Restoring unfinished uploads',
      progress: {
        stage: 'prepare',
        completed: 0,
        total: 0,
        unit: 'checkpoints',
        detail: 'Finding upload checkpoints',
      },
    })
    const checkpointKeys = await this.port.list(jobPrefix)
    this.update({
      progress: {
        stage: 'prepare',
        completed: 0,
        total: checkpointKeys.length,
        unit: 'checkpoints',
        detail: 'Restoring upload checkpoints',
      },
    })
    for (let start = 0; start < checkpointKeys.length; start += 256) {
      const values = await this.readMany(checkpointKeys.slice(start, start + 256))
      for (let i = start; i < Math.min(start + 256, checkpointKeys.length); i++) {
        const value = values.get(checkpointKeys[i])
        if (value) {
          const checkpoint: Checkpoint = JSON.parse(value)
          validateManifest(checkpoint.manifest)
          if (checkpoint.manifest.frameIds.every((id) => known.has(id)))
            await this.port.remove(checkpointKeys[i])
          else {
            checkpoints.push(checkpoint)
            checkpoint.manifest.frameIds.forEach((id) => claimed.add(id))
          }
        }
        this.update({
          progress: {
            stage: 'prepare',
            completed: i + 1,
            total: checkpointKeys.length,
            unit: 'checkpoints',
            detail: 'Restoring upload checkpoints',
          },
        })
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    // Plans contain source ranges only: audio is loaded by two preparation jobs,
    // not retained in the UI or materialized for the entire sync.
    const plans = await (this.port.planAudio ?? cooperativePlans)(
      indexes.filter((record) => byKey.has(record.key)),
      this.snapshot.settings.segmentSeconds,
      true,
      (value) =>
        this.update({
          phase: 'Planning Notion upload chunks',
          progress: { stage: 'prepare', ...this.planProgress(value) },
        }),
    )
    const jobs: Job[] = []
    for (const [index, checkpoint] of checkpoints.entries()) {
      this.update({
        phase: 'Restoring unfinished uploads',
        progress: {
          stage: 'prepare',
          completed: index,
          total: checkpoints.length,
          unit: 'checkpoints',
          detail: 'Restoring upload jobs',
        },
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const records = new Map<string, RecordIndex>()
      for (const id of checkpoint.manifest.frameIds) {
        const found = locate(id)
        if (!found || !byKey.has(found.record.key))
          throw Error(
            'An unfinished upload needs missing local audio. The Notion page is retained.',
          )
        records.set(found.record.key, found.record)
      }
      jobs.push({
        number: jobs.length + 1,
        checkpoint,
        manifest: checkpoint.manifest,
        records: [...records.values()],
      })
      this.update({
        progress: {
          stage: 'prepare',
          completed: index + 1,
          total: checkpoints.length,
          unit: 'checkpoints',
          detail: 'Restoring upload jobs',
        },
      })
    }
    for (const [index, plan] of plans.entries()) {
      this.update({
        phase: 'Planning Notion upload chunks',
        progress: {
          stage: 'prepare',
          completed: index,
          total: plans.length,
          unit: 'chunks',
          detail: 'Queuing audio chunks',
          plannedChunks: jobs.length,
        },
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const ranges = plan.ranges.filter((range) => {
        const record = byKey.get(range.key)!
        return Array.from({ length: range.to - range.from }, (_, i) =>
          frameId(record, range.from + i),
        ).some((id) => !known.has(id) && !claimed.has(id))
      })
      if (ranges.length)
        jobs.push({
          number: jobs.length + 1,
          plan: { ...plan, ranges },
          records: [...new Set(ranges.map((r) => byKey.get(r.key)!))],
        })
    }
    this.update({
      progress: {
        stage: 'prepare',
        completed: plans.length,
        total: plans.length,
        unit: 'chunks',
        detail: 'Upload plan ready',
        plannedChunks: jobs.length,
      },
    })
    let pipeline: PipelineProgress | undefined
    let currentChunk = 0
    const publish = (detail: string) =>
      this.update({
        progress: {
          stage: 'upload',
          completed,
          total,
          chunksCompleted,
          chunksTotal: jobs.length,
          chunkIndex: currentChunk,
          detail,
          pipeline,
        },
      })
    const saveCheckpoint = async (job: Job) =>
      this.port.put(job.key!, JSON.stringify(job.checkpoint))
    let commit: Promise<void> = Promise.resolve()
    const activeRecords = new Map<string, number>()
    const loadRecords = async (job: Job) => {
      for (const record of job.records)
        activeRecords.set(record.key, (activeRecords.get(record.key) ?? 0) + 1)
      const values = await this.readMany(
        job.records.filter((r) => !loaded.has(r.key)).map((r) => r.key),
      )
      for (const [key, value] of values) if (!loaded.has(key)) loaded.set(key, JSON.parse(value))
    }
    const sourceFrame = (index: RecordIndex, i: number): AudioSegment['frames'][number] => {
      const record = loaded.get(index.key)
      const frame = record?.frames[i]
      if (!frame)
        throw Error('An unfinished chunk needs missing local audio. No audio was removed.')
      return {
        ...frame,
        capturedAt: record.capturedAt
          ? new Date(Date.parse(record.capturedAt) + frame.offsetMs).toISOString()
          : null,
        recordTimestamp: record.timestampRaw,
        timing: record.timing,
        sequence: record.sequence,
        ringId: record.ringId,
      }
    }
    this.update({ phase: 'Syncing audio to Notion' })
    try {
      await runPipeline(
        jobs,
        {
          prepare: async (job) => {
            await guard()
            currentChunk = job.number
            publish(`Preparing audio chunk ${job.number} / ${jobs.length}`)
            await loadRecords(job)
            const frames: AudioSegment['frames'] = []
            const gaps: NonNullable<AudioManifest['gaps']> = []
            let sourceCount = 0
            let elapsedMs = 0
            if (job.checkpoint) {
              for (let i = 0; i < job.manifest!.frameIds.length; i++) {
                for (const gap of job.manifest!.gaps ?? [])
                  if (gap.beforeFrame === i)
                    frames.push(...silenceFrames(gap.durationMs, job.manifest!.frameIds[i]))
                const found = locate(job.manifest!.frameIds[i])!
                frames.push(sourceFrame(found.record, found.index))
              }
            } else
              for (const range of job.plan!.ranges) {
                const index = byKey.get(range.key)!
                const actual = []
                for (let i = range.from; i < range.to; i++) {
                  const id = frameId(index, i)
                  if (!known.has(id) && !claimed.has(id)) actual.push(sourceFrame(index, i))
                }
                if (!actual.length) continue
                if (range.gapMs && frames.length) {
                  gaps.push({
                    beforeFrame: sourceCount,
                    durationMs: range.gapMs,
                    offsetMs: elapsedMs,
                  })
                  frames.push(...silenceFrames(range.gapMs, actual[0].id))
                  elapsedMs += range.gapMs
                }
                frames.push(...actual)
                sourceCount += actual.length
                elapsedMs += actual.reduce((n, frame) => n + frame.durationMs, 0)
              }
            if (!frames.length) throw Error('No source audio remains in this chunk.')
            job.segment = {
              schema: 'uomi.audio.v1',
              deviceId: job.manifest?.deviceId ?? job.plan!.deviceId,
              codec: 'opus',
              sampleRate: 16000,
              channels: 1,
              durationMs: frames.reduce((n, f) => n + f.durationMs, 0),
              frames,
            }
            if (!job.manifest) {
              job.audio = this.port.muxAudio ? await this.port.muxAudio(frames) : oggOpus(frames)
              const originals = frames.filter((f) => f.timing !== 'synthetic-silence')
              const ids = originals.map((f) => f.id)
              const identity = gaps.length ? { frameIds: ids, gaps } : ids
              const id = await this.port.hash(
                Buffer.from(JSON.stringify(identity)).toString('base64'),
              )
              const timing: AudioManifest['timing'] = []
              originals.forEach((frame, i) => {
                const previous = timing.at(-1)
                if (
                  previous &&
                  previous.sequence === frame.sequence &&
                  previous.ringId === frame.ringId &&
                  previous.timestamp === frame.recordTimestamp
                )
                  previous.frames++
                else
                  timing.push({
                    sequence: frame.sequence,
                    ringId: frame.ringId,
                    timestamp: frame.recordTimestamp,
                    capturedAt: frame.capturedAt,
                    firstFrame: i,
                    frames: 1,
                  })
              })
              job.manifest = {
                schema: 'uomi.notion.v1',
                id,
                deviceId: job.segment.deviceId,
                capturedAt: originals[0].capturedAt,
                durationMs: job.segment.durationMs,
                sha256: await this.port.hash(Buffer.from(job.audio).toString('base64')),
                frameIds: ids,
                timing,
                ...(gaps.length ? { gaps } : {}),
              }
            }
            if (!job.checkpoint) job.audioHashVerified = true
            job.key = `${jobPrefix}${job.manifest.id}`
            const reservationKey = `notion:reservation:${target}:${job.manifest.id}`
            const saved = job.checkpoint?.pageId ?? (await this.port.get(reservationKey))
            job.page = saved
              ? await store.page(saved)
              : this.port.reserveNotion && this.snapshot.settings.transcriberEndpoint
                ? await store.page(
                    await this.port.reserveNotion(
                      this.snapshot.settings.transcriberEndpoint!,
                      job.manifest,
                      await store.source(),
                    ),
                  )
                : await store.reserve(job.manifest)
            await this.port.put(reservationKey, job.page.id)
            job.checkpoint ??= { manifest: job.manifest, pageId: job.page.id }
            await saveCheckpoint(job)
          },
          audio: async (job) => {
            await guard()
            publish('Uploading audio')
            if (job.page.properties.Audio?.files?.length) {
              job.audio = undefined
              return
            }
            if (!(await store.reusableUpload(job.checkpoint!.audioId))) {
              job.audio ??= this.port.muxAudio
                ? await this.port.muxAudio(job.segment!.frames)
                : oggOpus(job.segment!.frames)
              // A resumed checkpoint must reproduce the exact original Ogg, including gaps.
              if (
                !job.audioHashVerified &&
                (await this.port.hash(Buffer.from(job.audio).toString('base64'))) !==
                  job.manifest!.sha256
              )
                throw Error('The resumed audio hash differs. Local audio is retained.')
              job.checkpoint!.audioId = await store.upload(
                `${job.manifest!.id}.ogg`,
                'audio/ogg',
                job.audio,
              )
              await saveCheckpoint(job)
            }
            job.audio = undefined
          },
          metadata: async (job) => {
            await guard()
            publish('Uploading audio metadata')
            if (job.page.properties.Manifest?.files?.length) return
            if (!(await store.reusableUpload(job.checkpoint!.metadataId))) {
              job.checkpoint!.metadataId = await store.upload(
                `${job.manifest!.id}.json`,
                'application/json',
                Buffer.from(JSON.stringify(job.manifest)),
              )
              await saveCheckpoint(job)
            }
          },
          attach: async (job) => {
            await guard()
            publish('Attaching files to Notion')
            job.page = await store.attachAudio(
              job.manifest!,
              job.page,
              job.checkpoint!.audioId,
              job.checkpoint!.metadataId,
            )
          },
          verify: async (job) => {
            let page = job.page
            if (shouldDelete) {
              publish('Verifying uploaded audio before local removal')
              page = (await this.verifiedManifest(store, page.id, job.manifest)).page
            }
            const remote = store.remote(page, job.manifest!, target)
            const acknowledgement = commit.then(async () => {
              await this.cacheRemote(remote)
              await this.port.put(`notion:page:${target}:${page.id}`, JSON.stringify(page))
              await this.port.put(
                `notion:manifest:${target}:${page.id}`,
                JSON.stringify({ signature: this.manifestSignature(page), manifest: job.manifest }),
              )
              for (const id of job.manifest!.frameIds) {
                if (!known.has(id)) completed++
                known.add(id)
                if (shouldDelete) verified.add(id)
              }
              await persistAcknowledgements(job.records)
              await this.port.remove(job.key!)
              chunksCompleted++
              publish('Audio chunk saved in Notion')
            })
            commit = acknowledgement.catch(() => {})
            await acknowledgement
            job.page = page
          },
          notify: async (job) => {
            await this.sendNotification(store.remote(job.page, job.manifest!, target))
            job.segment = undefined
            for (const record of job.records) {
              const count = (activeRecords.get(record.key) ?? 1) - 1
              if (count === 0) {
                activeRecords.delete(record.key)
                loaded.delete(record.key)
              } else activeRecords.set(record.key, count)
            }
          },
        },
        (value) => {
          pipeline = value
          publish('Processing audio upload queue')
        },
      )
    } finally {
      activeRecords.clear()
      loaded.clear()
    }
    await this.refresh()
  }
  // Explicit deletion remains available independently of verified auto-removal.
  async clearDelivered() {
    if (this.snapshot.busy) throw Error('Wait for the sync to finish.')
    const records = this.inventory().filter((record) => record.uploaded === record.frameCount)
    for (let start = 0; start < records.length; start += 256) {
      const batch = records.slice(start, start + 256)
      await this.writeBatch(
        batch.map((record) => ({ key: `seen:${record.key}`, value: record.key })),
        batch.map((record) => record.key),
      )
    }
    await this.refresh()
  }
  private async closeLink() {
    const unsubscribe = this.liveUnsubscribe
    this.liveUnsubscribe = undefined
    try {
      await unsubscribe?.()
    } catch {}
    await this.port.disconnect()
  }
  async setActive(active: boolean) {
    this.active = active
    if (active && this.port.optimizeAudio) void this.optimizeAudio()
    if (!active) await this.stopMonitor()
    if (!active && this.snapshot.settings.mode === 'manual') {
      this.deadline = 0
      this.cancelDownload?.()
      await this.closeLink()
    } else if (!active && this.snapshot.settings.mode === 'periodic' && !this.snapshot.busy)
      await this.port.disconnect()
    this.arm()
  }
  private arm() {
    clearTimeout(this.timer)
    const s = this.snapshot.settings
    if ((s.mode === 'realtime' && !this.port.nativeTicks) || (s.mode === 'periodic' && this.active))
      this.timer = setTimeout(
        async () => {
          await this.sync(s.mode === 'realtime' ? 'realtime' : 'periodic')
          this.arm()
        },
        s.mode === 'realtime' ? s.segmentSeconds * 1000 : 60000,
      )
  }
  dispose() {
    this.disposed = true
    void this.stopMonitor().catch(() => {})
    clearTimeout(this.timer)
    this.listeners.clear()
  }
}
