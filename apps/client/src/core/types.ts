import type { ChunkPlan, RecordIndex } from './catalog'
import type { PipelineProgress } from './pipeline'
import type { NotionRequest, RemoteRecording } from '@uomi/notion'
export type Mode = 'manual' | 'realtime' | 'periodic'
export type Compression = 'gzip' | 'deflate' | 'none'
export interface Settings {
  notionSource?: string
  deleteAfterUpload?: boolean
  transcriberEndpoint?: string
  mode: Mode
  endpoint: string
  secretHeader: string
  compression: Compression
  segmentSeconds: number
  intervalHours: number
  deviceAddress: string
}
export const defaults: Settings = {
  deleteAfterUpload: true,
  notionSource: '',
  transcriberEndpoint: '',
  mode: 'manual',
  endpoint: '',
  secretHeader: 'X-Uomi-Secret',
  compression: 'gzip',
  segmentSeconds: 600,
  intervalHours: 6,
  deviceAddress: '',
}
export interface Device {
  address: string
  name: string
  serial?: string
  firmware?: string
  battery?: number
  micGain?: number
}
export interface Frame {
  id: string
  data: string
  durationMs: number
  offsetMs: number
}
export interface Recording {
  notionTarget?: string
  key: string
  deviceId: string
  ringId: string | null
  sequence: string
  capturedAt: string | null
  timestampRaw: number
  timing: 'device-utc' | 'device-uptime'
  frames: Frame[]
  uploaded: number
  bytes: number
  receivedAt: string
}
export interface SyncProgress {
  stage: 'import' | 'upload' | 'prepare' | 'check' | 'refresh'
  detail?: string
  unit?: string
  plannedChunks?: number
  pipeline?: PipelineProgress
  chunkIndex?: number
  chunksTotal?: number
  chunksCompleted?: number
  completed: number
  total: number
}
export interface ImportMetrics {
  requestId?: string
  completed: number
  elapsedMs: number
  storageMs: number
  receivedBytes: number
  maxNotificationBytes: number
  mtu?: number | null
  txPhy?: number | null
  rxPhy?: number | null
  connectionIntervalMs?: number | null
}
export interface ImportRequest {
  id: string
  start: string
  count: number
  deviceId: string
  ringId: string | null
  cursorKey: string
  finalRange: boolean
}
export interface Snapshot {
  transfer?: ImportMetrics
  storageMigrationError?: string | null
  localPlans?: ChunkPlan[]
  catalog?: RecordIndex[]
  loadingRecords?: number
  remoteHasPrevious?: boolean
  remotePage?: number
  remoteHasMore?: boolean
  remoteRecordings: RemoteRecording[]
  checkingNotion: boolean
  progress: SyncProgress | null
  settings: Settings
  hasSecret: boolean
  device: Device | null
  recordings: Recording[]
  busy: boolean
  phase: string
  error: string | null
  lastSync: string | null
  lastDeviceSync?: string | null
  wifi: boolean
  droppedPackets: string
}
export interface Port {
  optimizeAudio?: () => Promise<number>
  importRing?: (
    request: ImportRequest,
    progress: (metrics: ImportMetrics) => void,
  ) => Promise<ImportMetrics>
  cancelImport?: (id: string) => Promise<void>
  planAudio?: (
    records: RecordIndex[],
    seconds: number,
    pendingOnly?: boolean,
    progress?: (value: import('./catalog').PlanningProgress) => void,
  ) => Promise<ChunkPlan[]>
  getMany?: (keys: string[]) => Promise<{ key: string; value: string }[]>
  mirrorCount?: (query: {
    target: string
    devices?: string[]
    from?: number
    until?: number
  }) => Promise<number>
  mirrorEntries?: (query: {
    target: string
    devices?: string[]
    from?: number
    until?: number
    limit?: number
    offset?: number
    search?: string
  }) => Promise<string[]>
  catalogEntries?: (after: string) => Promise<{ key: string; value: string }[]>
  batch?: (puts: { key: string; value: string }[], removes?: string[]) => Promise<void>
  readNotionAudio?: (url: string, sha256: string) => Promise<string>
  verifyNotionAudio?: (url: string, sha256: string) => Promise<void>
  reserveNotion?: (
    endpoint: string,
    manifest: import('@uomi/notion').AudioManifest,
    source: string,
  ) => Promise<string>
  muxAudio?: (frames: Frame[]) => Promise<Uint8Array>
  nativeTicks?: boolean
  notion?: (request: NotionRequest) => Promise<any>
  notionFile?: (
    pageId: string,
    property: 'Manifest' | 'Transcript',
    url?: string,
  ) => Promise<string>
  notifyTranscriber?: (endpoint: string, pageId: string) => Promise<void>
  transcriberSecret?: (value?: string) => Promise<string>
  entries?(prefix: string, after: string): Promise<{ key: string; value: string }[]>
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
  list(prefix: string): Promise<string[]>
  remove(key: string): Promise<void>
  secret(value?: string): Promise<string>
  hash(base64: string): Promise<string>
  scan(): Promise<Device[]>
  connect(address: string): Promise<void>
  disconnect(): Promise<void>
  read(service: string, char: string): Promise<string>
  write(service: string, char: string, base64: string): Promise<void>
  subscribe(
    service: string,
    char: string,
    listener: (data: string) => void,
  ): Promise<() => Promise<void>>
  wifi(): Promise<boolean>
  schedule(settings: Settings): Promise<void>
  post(
    endpoint: string,
    header: string,
    body: string,
    compression: Compression,
    id: string,
  ): Promise<void>
}
export function validateSettings(s: Settings): void {
  if (!['manual', 'realtime', 'periodic'].includes(s.mode)) throw Error('Choose a valid sync mode.')
  if (!['gzip', 'deflate', 'none'].includes(s.compression))
    throw Error('Choose a supported compression format.')
  if (s.endpoint) {
    const u = new URL(s.endpoint)
    if (u.protocol !== 'https:' || u.username || u.password || u.hash)
      throw Error('Use an HTTPS webhook URL without credentials or a fragment.')
  }
  if (
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(s.secretHeader) ||
    (/^(host|content-.*|connection|authorization|idempotency-key|x-uomi-.*)$/i.test(
      s.secretHeader,
    ) &&
      s.secretHeader.toLowerCase() !== 'x-uomi-secret')
  )
    throw Error('Choose a custom secret header, such as X-Uomi-Secret.')
  if (!Number.isInteger(s.segmentSeconds) || s.segmentSeconds < 1 || s.segmentSeconds > 900)
    throw Error('Segment length must be a whole number from 1 to 900 seconds.')
  if (!Number.isFinite(s.intervalHours) || s.intervalHours < 0.25 || s.intervalHours > 168)
    throw Error('Sync interval must be between 0.25 and 168 hours.')
  if (s.transcriberEndpoint) {
    const u = new URL(s.transcriberEndpoint)
    if (u.protocol !== 'https:' || u.username || u.password || u.hash)
      throw Error('Use an HTTPS transcriber URL without credentials or fragment.')
  }
  if (s.mode !== 'manual' && !s.endpoint && !s.notionSource)
    throw Error('Set a Notion database before enabling automatic sync.')
}
