import { oggOpus } from './playback'
import { uploadManifest, uploadBody } from './upload'
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
import { forEachBounded } from './pipeline'
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
import { periodicDue } from './segments'

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
        } catch (error) {
          this.update({
            droppedPackets: (BigInt(this.snapshot.droppedPackets) + 1n).toString(),
            error: `Live packet rejected: ${String(error)}`,
          })
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
  reportError(context: string, error: unknown) {
    const detail = `${context}: ${error instanceof Error ? error.message : String(error)}`
    this.update({ error: this.snapshot.error ? `${this.snapshot.error}\n${detail}` : detail })
  }
  private jobTimer: ReturnType<typeof setTimeout> | undefined
  private jobIds: string[] = []
  private jobsLoading = false
  private async refreshUploadJobs() {
    clearTimeout(this.jobTimer)
    if (!this.port.uploadStatus || !this.jobIds.length || this.jobsLoading || this.disposed) return
    this.jobsLoading = true
    const s = this.snapshot.settings
    const ids = [...this.jobIds]
    try {
      const jobs = await this.port.uploadStatus(s.endpoint, s.secretHeader, ids)
      if (
        this.disposed ||
        s.endpoint !== this.snapshot.settings.endpoint ||
        ids.join() !== this.jobIds.join()
      )
        return
      if (ids.some((id) => !jobs.some((job) => job.id === id)))
        throw Error('The server did not return every requested job.')
      this.update({ uploadJobs: jobs, jobStatusError: null })
    } catch (error) {
      if (
        !this.disposed &&
        s.endpoint === this.snapshot.settings.endpoint &&
        ids.join() === this.jobIds.join()
      )
        this.update({ jobStatusError: `Could not refresh transcription jobs: ${String(error)}` })
    } finally {
      this.jobsLoading = false
      if (
        !this.disposed &&
        this.active &&
        this.jobIds.length &&
        (!this.snapshot.uploadJobs?.length ||
          this.snapshot.uploadJobs.some(
            (job) =>
              (job.transcription &&
                !['done', 'completed', 'failed'].includes(job.transcription.status)) ||
              ['pending', 'processing', 'retry', 'uncertain'].includes(job.backup_status ?? ''),
          ))
      )
        this.jobTimer = setTimeout(() => void this.refreshUploadJobs(), 15000)
    }
  }
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
  private progressNotificationTimer: ReturnType<typeof setTimeout> | undefined
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
      ) {
        if (!this.progressNotificationTimer)
          this.progressNotificationTimer = setTimeout(
            () => {
              this.progressNotificationTimer = undefined
              this.lastProgressNotification = Date.now()
              if (!this.disposed) this.listeners.forEach((f) => f())
            },
            150 - (now - this.lastProgressNotification),
          )
        return
      }
      this.lastProgressNotification = now
    }
    clearTimeout(this.progressNotificationTimer)
    this.progressNotificationTimer = undefined
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
    const lastUploads = await this.port.get('lastUploads')
    if (lastUploads) {
      const stored = JSON.parse(lastUploads)
      // Jobs belong to one destination; never send another server's identities.
      if (stored.endpoint === this.snapshot.settings.endpoint && Array.isArray(stored.ids)) {
        this.jobIds = stored.ids.filter((id: unknown) => typeof id === 'string').slice(-64)
        void this.refreshUploadJobs()
      }
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
    } catch (error) {
      this.update({
        storageMigrationError: `Storage optimization paused: ${String(error)}. Existing recordings remain readable; restart to retry.`,
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
    const target = this.snapshot.settings.endpoint
    if (this.port.catalogEntries) {
      let after = ''
      for (;;) {
        const entries = await this.port.catalogEntries(after)
        if (generation !== this.refreshGeneration) return
        if (!entries.length) break
        for (const { value } of entries) {
          const record: RecordIndex = JSON.parse(value)
          if (record.notionTarget !== target) record.uploaded = 0
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
        if (record.notionTarget !== target) record.uploaded = 0
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
      remoteRecordings: [],
      loadingRecords: undefined,
      wifi,
    })
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
      if (!raw) throw Error('This local audio is no longer available. Its saved copy is in Sites.')
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
    validateSettings(settings)
    if (secret !== undefined && /[\r\n]/.test(secret))
      throw Error('The secret cannot contain line breaks.')
    const hasSecretAfter = secret === undefined ? this.snapshot.hasSecret : secret.length > 0
    if (settings.mode !== 'manual' && !hasSecretAfter)
      throw Error('Set a Sites API key before enabling automatic sync.')
    if (this.snapshot.busy) throw Error('Wait for the current sync before changing settings.')
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
      } catch (restoreError) {
        throw Error(
          `Settings could not be scheduled: ${String(e)}. Restoring the previous schedule also failed: ${String(restoreError)}`,
        )
      }
      throw e
    }
    if (previous.endpoint !== settings.endpoint) {
      clearTimeout(this.jobTimer)
      this.jobIds = []
      await this.port.remove('lastUploads')
      this.update({ uploadJobs: [], jobStatusError: null })
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
    const warnings: string[] = []
    try {
      serial = Buffer.from(await this.port.read(UUID.info, UUID.serial), 'base64')
        .toString('utf8')
        .replace(/\0/g, '')
        .trim()
    } catch (error) {
      warnings.push(`Device serial unavailable; using Bluetooth identity: ${String(error)}`)
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
    } catch (error) {
      warnings.push(`Battery reading unavailable: ${String(error)}`)
    }
    let micGain: number | undefined
    try {
      const value = Buffer.from(await this.port.read(UUID.settings, UUID.micGain), 'base64')
      if (value.length === 1 && value[0] <= 8) micGain = value[0]
    } catch (error) {
      warnings.push(`Microphone gain reading unavailable: ${String(error)}`)
    }
    return { address, name, serial, firmware, battery, micGain, warnings }
  }
  async importDevice() {
    if (!this.snapshot.settings.deviceAddress)
      throw Error('Pair an Omi before importing recordings.')
    return this.sync('manual', 'device')
  }
  async syncCloud() {
    await this.sync('manual', 'cloud')
  }
  async sync(
    reason: 'manual' | 'realtime' | 'periodic' = 'manual',
    scope: 'all' | 'device' | 'cloud' = 'all',
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
          : scope === 'cloud'
            ? 'Preparing upload'
            : 'Preparing sync',
    })
    let syncFailed = false
    let firstUploadError: unknown
    try {
      // Explicit manual actions are isolated; scheduled sync still runs both stages.
      if (scope !== 'device') {
        try {
          await this.upload()
        } catch (e) {
          if (scope === 'cloud' || !s.deviceAddress) throw e
          firstUploadError = e
        }
      }
      if (scope !== 'cloud' && s.deviceAddress) {
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
        phase:
          scope === 'device'
            ? 'Omi recordings saved locally'
            : this.snapshot.progress?.stage === 'upload'
              ? this.snapshot.phase
              : 'Sync complete',
      })
    } catch (e) {
      syncFailed = true
      const diagnostics = [firstUploadError, e].filter(Boolean).map((error) => String(error))
      if (scope !== 'cloud') {
        try {
          await this.liveUnsubscribe?.()
        } catch (error) {
          diagnostics.push(`Bluetooth unsubscribe failed: ${String(error)}`)
        }
        this.liveUnsubscribe = undefined
        try {
          await this.port.disconnect()
        } catch (error) {
          diagnostics.push(`Bluetooth disconnect failed: ${String(error)}`)
        }
      }
      this.update({
        error: [...new Set(diagnostics)].join('\n'),
        phase: 'Sync paused — recordings are kept locally',
        progress: null,
      })
    } finally {
      try {
        if (scope !== 'cloud' && (s.mode !== 'realtime' || !this.liveUnsubscribe))
          await this.closeLink()
      } catch (error) {
        this.reportError('Bluetooth cleanup failed', error)
      }
      if (syncFailed && scope === 'cloud') {
        // The pipeline has drained before reaching here. A read-only catalog
        // rebuild must not keep Retry/Settings disabled after the failure.
        this.update({ busy: false, progress: null })
        const originalError = this.snapshot.error
        void this.refresh().catch((refreshError) => {
          if (!this.snapshot.busy && this.snapshot.error === originalError)
            this.update({
              loadingRecords: undefined,
              error: `${originalError}\nLocal catalog refresh failed: ${String(refreshError)}`,
            })
        })
      } else {
        try {
          await this.refresh()
        } catch (e) {
          this.reportError('Local catalog refresh failed', e)
        }
        this.update({
          busy: false,
          progress: this.snapshot.progress?.stage === 'upload' ? this.snapshot.progress : null,
        })
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
            void this.port
              .cancelImport?.(requestId)
              .catch((error) => this.reportError('Import cancellation failed', error))
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
      } catch (error) {
        this.reportError('Stopping device import failed', error)
      }
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
    await this.refresh()
    const s = this.snapshot.settings
    if (!s.endpoint || !this.snapshot.hasSecret)
      throw Error('Add your Sites upload URL and API key in Settings. Audio stays local.')
    const inventory = this.inventory()
    const records = new Map(inventory.map((r) => [r.key, r]))
    const plans = await (this.port.planAudio ?? cooperativePlans)(
      inventory,
      s.segmentSeconds,
      true,
      (value) => this.update({ progress: { stage: 'prepare', ...this.planProgress(value) } }),
    )
    const sourceIds = (plan: ChunkPlan) =>
      plan.ranges.flatMap((range) =>
        Array.from({ length: range.to - range.from }, (_, i) =>
          frameId(records.get(range.key)!, range.from + i),
        ),
      )
    type Job = { plan: ChunkPlan; id: string }
    const jobs: Job[] = []
    const concurrency = 4
    await forEachBounded(
      plans,
      async (plan) => {
        const id = await this.port.hash(
          Buffer.from(JSON.stringify(sourceIds(plan))).toString('base64'),
        )
        jobs.push({ plan, id })
        this.update({
          progress: {
            stage: 'prepare',
            completed: jobs.length,
            total: plans.length,
            unit: 'chunks',
            detail: 'Preparing upload identities',
          },
        })
      },
      concurrency,
    )
    const known = new Map<string, import('./types').UploadStatus>()
    const transcription = () => {
      const result = { pending: 0, processing: 0, done: 0, failed: 0, errors: [] as string[] }
      for (const value of known.values()) {
        const job = value.transcription
        if (!job) continue
        if (job.status === 'completed' || job.status === 'done') result.done++
        else if (job.status === 'failed') {
          result.failed++
          if (job.error) result.errors.push(`${value.id}: ${job.error}`)
        } else if (job.status === 'processing') result.processing++
        else result.pending++
      }
      return result
    }
    const checkStatus = async (batch: Job[]) => {
      if (!this.port.uploadStatus) return []
      const result = await this.port.uploadStatus(
        s.endpoint,
        s.secretHeader,
        batch.map((j) => j.id),
      )
      const found = new Map(result.map((r) => [r.id, r]))
      if (
        batch.some(
          (j) =>
            !found.has(j.id) ||
            !['missing', 'pending', 'saved', 'failed'].includes(found.get(j.id)!.status),
        )
      )
        throw Error('Invalid upload status response. Audio stays local.')
      for (const result of found.values()) known.set(result.id, result)
      return batch.map((j) => found.get(j.id)!)
    }
    if (this.port.uploadStatus)
      for (let i = 0; i < jobs.length; i += 64) {
        this.update({
          phase: 'Checking server recordings',
          progress: {
            stage: 'check',
            completed: i,
            total: jobs.length,
            unit: 'chunks',
            detail: 'Checking existing uploads without sending audio',
          },
        })
        for (const result of await checkStatus(jobs.slice(i, i + 64))) known.set(result.id, result)
      }
    const total = plans.reduce((n, p) => n + p.sourceFrames - p.deliveredFrames, 0)
    let completed = 0,
      submitted = 0,
      verified = 0,
      active = 0,
      preparing = 0
    let checkingSaves = false
    let saveCheckedAt = this.port.uploadStatus ? Date.now() : undefined
    const waiting = new Map<string, Job>()
    const errors = new Map<string, string>()
    const progress = (): SyncProgress => ({
      stage: 'upload',
      completed,
      total,
      unit: 'audio frames uploaded',
      chunksTotal: plans.length,
      chunksSubmitted: submitted,
      chunksCompleted: verified,
      chunksStaged: waiting.size,
      chunksSaveFailed: errors.size,
      transcription: transcription(),
      chunksActive: active,
      chunksPreparing: preparing,
      checkingSaves,
      saveCheckedAt,
      concurrency,
      updatedAt: Date.now(),
    })
    const report = () =>
      this.update({
        phase: checkingSaves ? 'Audio uploaded; checking server saves' : 'Uploading audio',
        progress: progress(),
      })
    let acknowledgement = Promise.resolve()
    const pending = new Map<string, Set<string>>()
    const acknowledge = (job: Job) => {
      const commit = acknowledgement.then(async () => {
        const accepted = new Set(sourceIds(job.plan))
        const updates: { key: string; uploaded: number; target: string }[] = []
        for (const key of new Set(job.plan.ranges.map((r) => r.key))) {
          const record = records.get(key)
          if (!record) throw Error('Local audio disappeared before acknowledgement.')
          const ids = pending.get(key) ?? new Set<string>()
          for (let i = 0; i < record.frameCount; i++) {
            const id = frameId(record, i)
            if (accepted.has(id)) ids.add(id)
          }
          let uploaded = record.notionTarget === s.endpoint ? record.uploaded : 0
          while (uploaded < record.frameCount && ids.delete(frameId(record, uploaded))) uploaded++
          if (ids.size) pending.set(key, ids)
          else pending.delete(key)
          updates.push({ key, uploaded, target: s.endpoint })
        }
        if (this.port.acknowledgeAudio) {
          for (let i = 0; i < updates.length; i += 256)
            await this.port.acknowledgeAudio(updates.slice(i, i + 256))
        } else {
          const puts: { key: string; value: string }[] = []
          for (const update of updates) {
            const raw = await this.port.get(update.key)
            if (!raw) throw Error('Local audio disappeared before acknowledgement.')
            const record: Recording = JSON.parse(raw)
            record.uploaded = update.uploaded
            record.notionTarget = update.target
            puts.push({ key: update.key, value: JSON.stringify(record) })
          }
          await this.writeBatch(puts)
        }
        for (const update of updates) {
          const record = records.get(update.key)!
          records.set(update.key, {
            ...record,
            uploaded: update.uploaded,
            notionTarget: update.target,
          })
        }
        verified++
      })
      acknowledgement = commit.catch(() => {})
      return commit
    }
    let wakeMonitor: (() => void) | undefined
    const transfer = () =>
      forEachBounded(
        jobs,
        async (job) => {
          preparing++
          report()
          let step: 'prepare' | 'send' | 'save' = 'prepare'
          try {
            if (Date.now() > this.deadline)
              throw Error('Background time limit reached. Sync again to resume.')
            if (this.syncReason === 'periodic' && !(await this.port.wifi()))
              throw Error('Wi-Fi disconnected. Audio stays local.')
            const status = known.get(job.id)
            let canonical = status?.status === 'saved'
            if (!status || status.status === 'missing') {
              const frames = (await this.loadLocalChunk(job.plan)).filter(
                (f) => f.timing !== 'synthetic-silence',
              )
              const audio = this.port.muxAudio ? await this.port.muxAudio(frames) : oggOpus(frames)
              const sha256 = await this.port.hash(Buffer.from(audio).toString('base64'))
              const manifest = uploadManifest(job.plan.deviceId, frames, job.id, sha256)
              preparing--
              step = 'send'
              active++
              report()
              canonical =
                (await this.port.post(
                  s.endpoint,
                  s.secretHeader,
                  uploadBody(manifest, audio),
                  'none',
                  job.id,
                  true,
                )) === true
              active--
            } else preparing--
            step = 'save'
            submitted++
            completed += job.plan.sourceFrames - job.plan.deliveredFrames
            report()
            if (canonical) await acknowledge(job)
            else if (status?.status === 'failed')
              errors.set(job.id, status.error ?? 'Server save failed')
            else {
              waiting.set(job.id, job)
              wakeMonitor?.()
            }
          } finally {
            if (step === 'prepare') preparing--
            else if (step === 'send') active--
            report()
          }
        },
        concurrency,
      )
    let uploading = true
    let stopMonitoring = false
    let monitorDeadline = Infinity
    let statusError: unknown
    const monitor = async () => {
      if (!this.port.uploadStatus) return
      try {
        while (!stopMonitoring && (uploading || waiting.size)) {
          if (Date.now() > Math.min(monitorDeadline, this.deadline)) break
          const pendingJobs = [...waiting.values()]
          for (let i = 0; i < pendingJobs.length; i += 64) {
            const batch = pendingJobs.slice(i, i + 64)
            for (const status of await checkStatus(batch)) {
              const job = waiting.get(status.id)
              if (!job) continue
              if (status.status === 'saved') {
                await acknowledge(job)
                waiting.delete(status.id)
              } else if (status.status === 'failed' || status.status === 'missing') {
                errors.set(
                  status.id,
                  status.error ?? 'Server no longer has this audio. Upload again to retry.',
                )
                waiting.delete(status.id)
              }
            }
            saveCheckedAt = Date.now()
            report()
          }
          if (!uploading && !waiting.size) break
          await new Promise<void>((resolve) => {
            const wake = () => {
              clearTimeout(timer)
              wakeMonitor = undefined
              resolve()
            }
            const timer = setTimeout(wake, 3000)
            wakeMonitor = wake
          })
        }
      } catch (error) {
        statusError = error
      }
    }
    report()
    const monitoring = monitor()
    try {
      await transfer()
    } catch (error) {
      stopMonitoring = true
      throw error
    } finally {
      uploading = false
      checkingSaves = waiting.size > 0 && !!this.port.uploadStatus
      monitorDeadline = Date.now() + 60000
      wakeMonitor?.()
      if (!stopMonitoring && checkingSaves) report()
      await monitoring
      checkingSaves = false
    }
    if (statusError)
      this.update({
        error: `Could not refresh save status: ${String(statusError)}. Audio stays local.`,
      })
    if (this.port.uploadStatus && jobs.length && !statusError) {
      try {
        for (let i = 0; i < jobs.length; i += 64) await checkStatus(jobs.slice(i, i + 64))
      } catch (error) {
        this.update({ error: `Audio saved; job status could not be refreshed: ${String(error)}` })
      }
    }
    if (jobs.length && this.port.uploadStatus) {
      this.jobIds = jobs.map((job) => job.id).slice(-64)
      await this.port.put('lastUploads', JSON.stringify({ endpoint: s.endpoint, ids: this.jobIds }))
      this.update({ uploadJobs: [...known.values()].filter((job) => this.jobIds.includes(job.id)) })
      clearTimeout(this.jobTimer)
      if (this.active) this.jobTimer = setTimeout(() => void this.refreshUploadJobs(), 15000)
    } else if (!jobs.length && this.jobIds.length) await this.refreshUploadJobs()
    await this.refresh()
    this.update({
      phase: !plans.length
        ? 'No audio waiting to upload'
        : errors.size
          ? 'Audio uploaded; server save needs attention'
          : waiting.size
            ? `Upload complete; ${waiting.size} chunks awaiting save confirmation`
            : 'Upload complete; all audio safely saved',
      error: errors.size
        ? `Server save failures:\n${[...errors].map(([id, message]) => `${id}: ${message}`).join('\n')}\nOriginal audio stays on this device.`
        : this.snapshot.error,
      progress: progress(),
    })
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
    let failure: unknown
    try {
      await unsubscribe?.()
    } catch (error) {
      failure = error
    }
    try {
      await this.port.disconnect()
    } catch (error) {
      throw Error(
        `Bluetooth disconnect failed: ${String(error)}${failure ? `; unsubscribe failed: ${String(failure)}` : ''}`,
      )
    }
    if (failure) throw Error(`Bluetooth unsubscribe failed: ${String(failure)}`)
  }
  async setActive(active: boolean) {
    this.active = active
    if (!active) clearTimeout(this.jobTimer)
    else if (this.jobIds.length) void this.refreshUploadJobs()
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
          try {
            await this.sync(s.mode === 'realtime' ? 'realtime' : 'periodic')
          } catch (error) {
            this.reportError('Scheduled sync failed', error)
          }
          this.arm()
        },
        s.mode === 'realtime' ? s.segmentSeconds * 1000 : 60000,
      )
  }
  dispose() {
    clearTimeout(this.jobTimer)
    this.disposed = true
    void this.stopMonitor().catch((error) => console.error('Stopping audio monitor failed', error))
    clearTimeout(this.timer)
    clearTimeout(this.progressNotificationTimer)
    this.listeners.clear()
  }
}
