import type { Client } from './runtime'
import { isTauri } from '@tauri-apps/api/core'
import { tauriClient } from './tauri'
export const client: Client = isTauri()
  ? tauriClient
  : import.meta.env.DEV && window.uomi
    ? window.uomi
    : previewClient()
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
    loadRemoteAudio: unavailable,
    moreRemote: unavailable,
    previousRemote: unavailable,
    searchRemote: unavailable,
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    init: async () => {},
    save: unavailable,
    scan: unavailable,
    pair: unavailable,
    unpair: unavailable,
    sync: unavailable,
    importDevice: unavailable,
    syncNotion: unavailable,
    clearDelivered: unavailable,
    refreshNotion: unavailable,
    retryTranscription: unavailable,
    loadTranscript: unavailable,
    micGain: unavailable,
    startMonitor: unavailable,
    stopMonitor: async () => {},
  }
}
