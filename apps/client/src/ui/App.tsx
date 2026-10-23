import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { View, ScrollView, StyleSheet, Linking, useColorScheme } from 'react-native'
import {
  PaperProvider,
  MD3DarkTheme,
  MD3LightTheme,
  Text,
  Button,
  TextInput,
  SegmentedButtons,
  ProgressBar,
  Snackbar,
  Divider,
  ActivityIndicator,
  List,
} from 'react-native-paper'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { client } from '../platform/runtime'
import type { Device, Settings } from '../core/types'

export default function App() {
  const dark = useColorScheme() === 'dark'
  return (
    <SafeAreaProvider>
      <PaperProvider theme={dark ? MD3DarkTheme : MD3LightTheme}>
        <SyncApp />
      </PaperProvider>
    </SafeAreaProvider>
  )
}
function SyncApp() {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot),
    [tab, setTab] = useState('sync'),
    [draft, setDraft] = useState<Settings>(state.settings),
    [key, setKey] = useState(''),
    [access, setAccess] = useState(''),
    [devices, setDevices] = useState<Device[]>([]),
    [scanning, setScanning] = useState(false),
    [message, setMessage] = useState('')
  useEffect(() => {
    void client.init().catch((e) => setMessage(String(e)))
  }, [])
  useEffect(() => {
    setDraft(state.settings)
  }, [state.settings])
  const action = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    }
  }
  const records =
      state.catalog ?? state.recordings.map((r) => ({ ...r, frameCount: r.frames.length })),
    pending = records.filter((r) => r.uploaded < r.frameCount).length
  const viewer = () => {
    try {
      return new URL(state.settings.endpoint).origin
    } catch {
      return ''
    }
  }
  const busy = state.busy || scanning
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <View>
            <Text variant="headlineLarge">Uomi</Text>
            <Text variant="bodyMedium">Capture here. Listen on the web.</Text>
          </View>
          <Button mode="text" disabled={!viewer()} onPress={() => void Linking.openURL(viewer())}>
            Open Recorder
          </Button>
        </View>
        <SegmentedButtons
          value={tab}
          onValueChange={setTab}
          buttons={[
            { value: 'sync', label: 'Sync' },
            { value: 'settings', label: 'Settings' },
          ]}
        />
        {tab === 'sync' ? (
          <View style={styles.section}>
            <Text variant="headlineMedium">
              {state.busy
                ? 'Syncing recordings'
                : pending
                  ? `${pending} recordings to sync`
                  : 'Ready to sync'}
            </Text>
            <Text variant="bodyLarge">{state.phase}</Text>
            {state.progress && (
              <>
                <ProgressBar
                  progress={
                    state.progress.total ? state.progress.completed / state.progress.total : 0
                  }
                  indeterminate={!state.progress.total}
                />
                <Text>
                  {state.progress.detail ?? `${state.progress.completed} / ${state.progress.total}`}
                </Text>
              </>
            )}
            {state.error && (
              <Text accessibilityRole="alert" style={{ color: '#b3261e' }}>
                {state.error}
              </Text>
            )}
            <View style={styles.actions}>
              <Button
                mode="contained"
                loading={state.busy}
                disabled={
                  busy ||
                  !state.settings.deviceAddress ||
                  !state.settings.endpoint ||
                  !state.hasSecret
                }
                onPress={() => void action(() => client.sync())}
              >
                Import & sync
              </Button>
              <Button
                mode="outlined"
                disabled={busy || !state.settings.endpoint || !state.hasSecret}
                onPress={() => void action(() => client.syncCloud())}
              >
                Send saved audio
              </Button>
            </View>
            <Text variant="bodyMedium">
              Original Opus audio is cached on Sites, then saved to Notion. Sync again to confirm
              pending saves. Local recordings stay here until you explicitly clear uploaded copies.
            </Text>
            <Divider />
            <Text variant="titleLarge">Omi device</Text>
            {state.device ? (
              <>
                <List.Item
                  title={state.device.name}
                  description={`${state.device.address}${state.device.battery !== undefined ? ` · ${state.device.battery}% battery` : ''}`}
                />
                <View style={styles.actions}>
                  <Button disabled={busy} onPress={() => void action(() => client.importDevice())}>
                    Import only
                  </Button>
                  <Button disabled={busy} onPress={() => void action(() => client.unpair())}>
                    Disconnect
                  </Button>
                </View>
                <TextInput
                  mode="outlined"
                  label="Microphone gain (0–30)"
                  keyboardType="numeric"
                  defaultValue={String(state.device.micGain ?? 10)}
                  onSubmitEditing={(e) =>
                    void action(() => client.micGain(Number(e.nativeEvent.text)))
                  }
                />
              </>
            ) : (
              <Text>Pair Omi to import its saved recordings.</Text>
            )}
            <Button
              mode="outlined"
              loading={scanning}
              disabled={busy}
              onPress={() => {
                setScanning(true)
                void action(async () => setDevices(await client.scan())).finally(() =>
                  setScanning(false),
                )
              }}
            >
              Find Omi
            </Button>
            {devices.map((d) => (
              <List.Item
                key={d.address}
                title={d.name}
                description={d.address}
                onPress={() =>
                  void action(async () => {
                    await client.pair(d)
                    setDevices([])
                  })
                }
              />
            ))}
            <Divider />
            <Text>
              Last import:{' '}
              {state.lastDeviceSync ? new Date(state.lastDeviceSync).toLocaleString() : 'Not yet'}
            </Text>
            <Text>
              Last upload: {state.lastSync ? new Date(state.lastSync).toLocaleString() : 'Not yet'}
            </Text>
            <Text>Network: {state.wifi ? 'Wi-Fi available' : 'Wi-Fi unavailable'}</Text>
            <Button disabled={busy} onPress={() => void action(() => client.clearDelivered())}>
              Clear uploaded local copies
            </Button>
            <Text variant="bodySmall">
              This removes only audio confirmed saved to Notion through your current Sites
              destination. It does not delete R2 or Notion data.
            </Text>
          </View>
        ) : (
          <View style={styles.section}>
            <Text variant="headlineMedium">Connect to Recorder</Text>
            <Text>
              In the Web Recorder, open Devices and create an access key. Copy its upload URL, API
              key and Sites access token below.
            </Text>
            <TextInput
              mode="outlined"
              label="Upload URL"
              autoCapitalize="none"
              value={draft.endpoint}
              onChangeText={(endpoint) => setDraft({ ...draft, endpoint })}
            />
            <TextInput
              mode="outlined"
              label={state.hasSecret ? 'API key (saved securely)' : 'API key'}
              secureTextEntry
              autoCapitalize="none"
              value={key}
              onChangeText={setKey}
            />
            <TextInput
              mode="outlined"
              label="Sites access token (leave blank to keep saved)"
              secureTextEntry
              autoCapitalize="none"
              value={access}
              onChangeText={setAccess}
            />
            <Text variant="titleMedium">Sync mode</Text>
            <SegmentedButtons
              value={draft.mode}
              onValueChange={(mode) => setDraft({ ...draft, mode: mode as Settings['mode'] })}
              buttons={[
                { value: 'manual', label: 'Manual' },
                { value: 'periodic', label: 'Periodic' },
                { value: 'realtime', label: 'Real-time' },
              ]}
            />
            <TextInput
              mode="outlined"
              label="Maximum chunk length (seconds, 1–900)"
              keyboardType="numeric"
              value={String(draft.segmentSeconds)}
              onChangeText={(v) => setDraft({ ...draft, segmentSeconds: Number(v) })}
            />
            <TextInput
              mode="outlined"
              label="Periodic interval (hours)"
              keyboardType="numeric"
              value={String(draft.intervalHours)}
              onChangeText={(v) => setDraft({ ...draft, intervalHours: Number(v) })}
            />
            <Text>
              Manual mode runs only when requested. Periodic mode uses Wi-Fi jobs. Real-time mode
              keeps native background work active.
            </Text>
            <Button
              mode="contained"
              disabled={busy}
              onPress={() =>
                void action(async () => {
                  await client.save(
                    {
                      ...draft,
                      notionSource: '',
                      transcriberEndpoint: '',
                      deleteAfterUpload: false,
                      secretHeader: 'X-Uomi-Secret',
                      compression: 'none',
                    },
                    key || undefined,
                    access || undefined,
                  )
                  setKey('')
                  setAccess('')
                  setMessage('Connection settings saved')
                })
              }
            >
              Save settings
            </Button>
          </View>
        )}
      </ScrollView>
      <Snackbar
        visible={!!message}
        onDismiss={() => setMessage('')}
        action={{ label: 'Dismiss', onPress: () => setMessage('') }}
      >
        {message}
      </Snackbar>
    </SafeAreaView>
  )
}
const styles = StyleSheet.create({
  page: { padding: 24, gap: 24, width: '100%', maxWidth: 800, alignSelf: 'center' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  section: { gap: 20 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
})
