import { planAudio } from './plan.web'
import { muxAudio } from './mux'
import { paceTransport } from '@uomi/notion'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Engine } from '../core/engine'
import type { Port, Device, ImportMetrics } from '../core/types'
import type { Client } from './runtime'

const api = paceTransport((request) => invoke('notion', { request }))
const port: Port = {
  optimizeAudio: () => invoke('kv', { action: 'optimizeAudio', key: '', value: null }),
  cancelImport: (id) => invoke('cancel_import', { id }),
  importRing: async (request, progress) => {
    const unlisten = await listen<ImportMetrics>('uomi:import', (event) => {
      if (event.payload.requestId === request.id) progress(event.payload)
    })
    try {
      return await invoke<ImportMetrics>('import_ring', { request })
    } finally {
      unlisten()
    }
  },
  muxAudio,
  planAudio,
  reserveNotion: (endpoint, manifest, source) =>
    invoke('transcriber_reserve', {
      endpoint,
      source,
      manifest: {
        id: manifest.id,
        sha256: manifest.sha256,
        deviceId: manifest.deviceId,
        capturedAt: manifest.capturedAt,
        durationMs: manifest.durationMs,
        frameIds: manifest.frameIds,
        gaps: manifest.gaps,
      },
    }),
  getMany: (keys) => invoke('kv', { action: 'getMany', key: '', value: JSON.stringify(keys) }),
  mirrorCount: (query) =>
    invoke('kv', {
      action: 'mirror',
      key: '',
      value: JSON.stringify({ ...query, countOnly: true }),
    }),
  mirrorEntries: (query) =>
    invoke('kv', { action: 'mirror', key: '', value: JSON.stringify(query) }),
  catalogEntries: (after) => invoke('kv', { action: 'catalog', key: '', value: after }),
  batch: (puts, removes = []) =>
    invoke('kv', { action: 'batch', key: '', value: JSON.stringify({ puts, removes }) }),
  readNotionAudio: (url, sha256) => invoke('verify_notion_audio', { url, sha256, download: true }),
  verifyNotionAudio: (url, sha256) =>
    invoke('verify_notion_audio', { url, sha256, download: false }),
  nativeTicks: true,
  entries: (key, after) => invoke('kv', { action: 'entries', key, value: after }),
  get: (key) => invoke('kv', { action: 'get', key, value: null }),
  put: (key, value) => invoke('kv', { action: 'put', key, value }),
  list: (key) => invoke('kv', { action: 'list', key, value: null }),
  remove: (key) => invoke('kv', { action: 'remove', key, value: null }),
  secret: (value) => invoke('credential', { name: 'notion', value: value ?? null }),
  transcriberSecret: (value) => invoke('credential', { name: 'transcriber', value: value ?? null }),
  notion: api,
  notionFile: async (pageId, property, url) => {
    if (!url) {
      const page = await api({ path: `/pages/${pageId}`, method: 'GET' })
      url = page.properties[property]?.files?.[0]?.file?.url
    }
    return invoke('notion_file', { pageId, property, fileUrl: url ?? null })
  },
  notifyTranscriber: (endpoint, pageId) => invoke('transcriber_notify', { endpoint, pageId }),
  hash: (value) => invoke('hash', { value }),
  scan: () => invoke<Device[]>('scan'),
  connect: (address) => invoke('connect', { address }),
  disconnect: () => invoke('disconnect'),
  read: (service, char) => invoke('read', { service, char }),
  write: (service, char, value) => invoke('write', { service, char, value }),
  wifi: () => invoke('wifi'),
  schedule: (settings) => invoke('schedule', { settings }),
  post: (endpoint, header, body, compression, id) =>
    invoke('post', { endpoint, header, body, compression, id }),
  subscribe: async (service, char, listener) => {
    const unlisten = await listen<{ char: string; data: string }>('uomi:ble', (event) => {
      if (event.payload.char === char) listener(event.payload.data)
    })
    try {
      await invoke('notify', { service, char, enabled: true })
    } catch (e) {
      unlisten()
      throw e
    }
    return async () => {
      unlisten()
      await invoke('notify', { service, char, enabled: false })
    }
  },
}
const engine = new Engine(port)
let startup: Promise<void> | undefined
export const tauriClient: Client = {
  loadLocalChunk: (plan) => engine.loadLocalChunk(plan),
  loadRemoteAudio: (pageId) => engine.loadRemoteAudio(pageId),
  moreRemote: () => engine.moreRemote(),
  previousRemote: () => engine.previousRemote(),
  searchRemote: (query) => engine.searchRemote(query),
  getSnapshot: engine.getSnapshot,
  micGain: (level) => engine.micGain(level),
  startMonitor: (onFrame) => engine.startMonitor(onFrame),
  stopMonitor: () => engine.stopMonitor(),
  subscribe: engine.subscribe,
  save: (s, secret, transcriberSecret) => engine.save(s, secret, transcriberSecret),
  scan: () => engine.scan(),
  pair: (device) => engine.pair(device),
  unpair: () => engine.unpair(),
  sync: () => engine.sync('manual'),
  importDevice: () => engine.importDevice(),
  syncNotion: () => engine.syncNotion(),
  clearDelivered: () => engine.clearDelivered(),
  refreshNotion: () => engine.refreshNotion(),
  retryTranscription: (pageId) => engine.retryTranscription(pageId),
  loadTranscript: (pageId) => engine.loadTranscript(pageId),
  init: () =>
    (startup ??= (async () => {
      const periodic = await invoke<boolean>('is_periodic')
      await listen('uomi:tick', () => {
        void engine.sync('realtime')
      })
      await listen('uomi:periodic', () => {
        void engine.sync('periodic')
      })
      await listen<boolean>('uomi:active', (event) => {
        void engine.setActive(event.payload)
      })
      try {
        await engine.init()
        await engine.setActive(!periodic)
        if (!periodic)
          setTimeout(() => {
            void invoke('smoke_ready')
          }, 1500)
        if (periodic) {
          await engine.sync('periodic')
          await invoke('finish_periodic', {
            success: !engine.getSnapshot().error,
          })
        }
      } catch (e) {
        if (periodic) await invoke('finish_periodic', { success: false })
        throw e
      }
    })().catch((e) => {
      startup = undefined
      throw e
    })),
}
