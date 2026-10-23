import { muxAudio } from './mux'
import { paceTransport } from '@uomi/notion'
import {
  NativeEventEmitter,
  NativeModules,
  Platform,
  AppState,
  PermissionsAndroid,
} from 'react-native'
import { Engine } from '../core/engine'
import type { Port, Settings } from '../core/types'
export interface Client {
  loadLocalChunk: Engine['loadLocalChunk']
  syncCloud: Engine['syncCloud']
  importDevice: Engine['importDevice']
  micGain: Engine['micGain']
  startMonitor: Engine['startMonitor']
  stopMonitor: Engine['stopMonitor']
  getSnapshot: Engine['getSnapshot']
  subscribe: Engine['subscribe']
  init: Engine['init']
  save: Engine['save']
  scan: Engine['scan']
  pair: Engine['pair']
  unpair: Engine['unpair']
  sync: Engine['sync']
  clearDelivered: Engine['clearDelivered']
}
declare global {
  interface Window {
    uomi?: Client
  }
}
async function permissions() {
  if (Platform.OS !== 'android') return
  const list =
    Number(Platform.Version) >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]
  const grants = await PermissionsAndroid.requestMultiple(list)
  if (Object.values(grants).some((v) => v !== PermissionsAndroid.RESULTS.GRANTED))
    throw Error('Bluetooth permission is required. Allow it in Android app settings.')
}
function nativePort(): Port {
  const native = NativeModules.Uomi
  const events = new NativeEventEmitter(native)
  const api = paceTransport(async (request) =>
    JSON.parse(await native.notion(JSON.stringify(request))),
  )
  return {
    acknowledgeAudio: (updates) => native.acknowledgeAudio(JSON.stringify(updates)),
    uploadStatus: (endpoint, header, ids) =>
      native.uploadStatus(endpoint, header, JSON.stringify(ids)).then(JSON.parse),
    optimizeAudio: () => native.optimizeAudio(),
    cancelImport: (id) => native.cancelImport(id),
    importRing: async (request, progress) => {
      const listener = events.addListener('UomiImport', (payload) => {
        const metrics = payload as import('../core/types').ImportMetrics
        if (metrics.requestId === request.id) progress(metrics)
      })
      try {
        return await native.importRing(JSON.stringify(request))
      } finally {
        listener.remove()
      }
    },
    entries: (prefix, after) => native.entries(prefix, after),
    muxAudio,
    reserveNotion: (endpoint, manifest, source) =>
      native.transcriberReserve(
        endpoint,
        JSON.stringify({
          id: manifest.id,
          sha256: manifest.sha256,
          deviceId: manifest.deviceId,
          capturedAt: manifest.capturedAt,
          durationMs: manifest.durationMs,
          frameIds: manifest.frameIds,
          gaps: manifest.gaps,
        }),
        source,
      ),
    getMany: (keys) => native.getMany(JSON.stringify(keys)),
    mirrorCount: (query) => native.mirrorEntries(JSON.stringify({ ...query, countOnly: true })),
    mirrorEntries: (query) => native.mirrorEntries(JSON.stringify(query)),
    catalogEntries: native.catalogEntries,
    batch: (puts, removes = []) => native.batch(JSON.stringify({ puts, removes })),
    verifyNotionAudio: native.verifyNotionAudio,
    readNotionAudio: native.readNotionAudio,
    get: native.get,
    put: native.put,
    list: native.list,
    remove: native.remove,
    secret: (v) => native.credential('sites-api', v ?? null),
    transcriberSecret: (v) => native.credential('sites-access', v ?? null),
    notion: api,
    notionFile: async (pageId, property, url) => {
      if (!url) {
        const page = await api({ path: `/pages/${pageId}`, method: 'GET' })
        url = page.properties[property]?.files?.[0]?.file?.url
      }
      return native.notionFile(pageId, property, url ?? null)
    },
    notifyTranscriber: native.transcriberNotify,
    hash: native.hash,
    scan: async () => {
      await permissions()
      return native.scan()
    },
    connect: async (address) => {
      await permissions()
      return native.connect(address)
    },
    disconnect: native.disconnect,
    read: native.read,
    write: native.write,
    wifi: native.wifi,
    schedule: async (s: Settings) => {
      if (s.mode === 'realtime') {
        await permissions()
        if (Number(Platform.Version) >= 33)
          await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)
      }
      return native.schedule(JSON.stringify(s))
    },
    post: (endpoint, header, body, compression, id, binary = false) =>
      native.post(endpoint, header, body, compression, id, binary),
    subscribe: async (service, char, listener) => {
      const sub = events.addListener('UomiBle', (e: any) => {
        if (e.char === char) listener(e.data)
      })
      try {
        await native.notify(service, char, true)
      } catch (e) {
        sub.remove()
        throw e
      }
      return async () => {
        sub.remove()
        await native.notify(service, char, false)
      }
    },
  }
}
let engine: Engine | undefined
export function getEngine() {
  if (!engine) {
    engine = new Engine(nativePort())
    void engine
      .setActive(AppState.currentState === 'active')
      .catch((error) => engine!.reportError('App lifecycle failed', error))
  }
  return engine
}
export const client: Client = Platform.OS === 'web' ? (window.uomi ?? previewClient()) : getEngine()
if (Platform.OS !== 'web')
  AppState.addEventListener('change', (state) => {
    void getEngine()
      .setActive(state === 'active')
      .catch((error) => getEngine().reportError('App lifecycle failed', error))
  })
function previewClient(): Client {
  const snapshot = {
    remoteRecordings: [],
    checkingNotion: false,
    progress: null,
    settings: {
      mode: 'manual' as const,
      endpoint: '',
      secretHeader: 'X-Uomi-Secret',
      compression: 'gzip' as const,
      segmentSeconds: 600,
      intervalHours: 6,
      deviceAddress: '',
    },
    hasSecret: false,
    device: null,
    recordings: [],
    busy: false,
    phase: 'Desktop preview',
    error: null,
    lastSync: null,
    wifi: false,
    droppedPackets: '0',
  }
  const unavailable = async (): Promise<never> => {
    throw Error(
      'Device and storage access require the Android app or Linux desktop app. Start the Linux app with bun run linux.',
    )
  }
  return {
    loadLocalChunk: unavailable,
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    init: async () => {},
    save: unavailable,
    scan: unavailable,
    pair: unavailable,
    unpair: unavailable,
    sync: unavailable,
    syncCloud: unavailable,
    importDevice: unavailable,
    clearDelivered: unavailable,
    micGain: unavailable,
    startMonitor: unavailable,
    stopMonitor: async () => {},
  }
}
