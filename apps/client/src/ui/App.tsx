import { SyncProgressView } from './SyncProgress'
import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { View, ScrollView, StyleSheet, Linking, useColorScheme } from 'react-native'
import {
  PaperProvider,
  useTheme,
  MD3DarkTheme,
  MD3LightTheme,
  Text,
  Button,
  TextInput,
  SegmentedButtons,
  Snackbar,
  Divider,
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
  const theme = useTheme()
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot),
    [tab, setTab] = useState('sync'),
    [draft, setDraft] = useState<Settings>(state.settings),
    [key, setKey] = useState(''),
    [access, setAccess] = useState(''),
    [devices, setDevices] = useState<Device[]>([]),
    [scanning, setScanning] = useState(false),
    [message, setMessage] = useState(''),
    [operationError, setOperationError] = useState(''),
    [acting, setActing] = useState(false),
    [gain, setGain] = useState<string | null>(null)
  useEffect(() => {
    void client.init().catch((e) => setOperationError(String(e)))
  }, [])
  useEffect(() => {
    setDraft(state.settings)
  }, [state.settings])
  const action = async (fn: () => Promise<unknown>) => {
    if (acting) return
    setActing(true)
    setOperationError('')
    try {
      await fn()
    } catch (e) {
      setOperationError(e instanceof Error ? e.message : String(e))
    } finally {
      setActing(false)
    }
  }
  const records =
      state.catalog ?? state.recordings.map((r) => ({ ...r, frameCount: r.frames.length })),
    pending = records.filter((r) => r.uploaded < r.frameCount).length
  const recorder = (() => {
    if (!state.settings.endpoint) return { url: '', error: null }
    try {
      return { url: new URL(state.settings.endpoint).origin, error: null }
    } catch (error) {
      return { url: '', error: `Invalid saved API URL: ${String(error)}. Update Settings.` }
    }
  })()
  const busy = state.busy || scanning || acting
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <View>
            <Text variant="headlineLarge">Uomi</Text>
          </View>
          <Button
            mode="text"
            disabled={!recorder.url}
            onPress={() => void action(() => Linking.openURL(recorder.url))}
          >
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
        {(operationError ||
          recorder.error ||
          state.error ||
          state.jobStatusError ||
          state.storageMigrationError) && (
          <View accessibilityRole="alert" style={styles.error}>
            <Text selectable style={{ color: theme.colors.error }}>
              {[
                operationError,
                recorder.error,
                state.error,
                state.jobStatusError,
                state.storageMigrationError,
              ]
                .filter(Boolean)
                .join('\n')}
            </Text>
          </View>
        )}
        {tab === 'sync' ? (
          <View style={styles.section}>
            <Text variant="headlineMedium">
              {state.busy
                ? state.progress?.stage === 'upload'
                  ? 'Uploading audio'
                  : 'Syncing recordings'
                : state.progress?.stage === 'upload'
                  ? 'Upload summary'
                  : pending
                    ? 'Audio ready to sync'
                    : 'Ready to sync'}
            </Text>
            <Text variant="bodyLarge" accessibilityLiveRegion="polite">
              {state.phase}
            </Text>
            <Text variant="bodyMedium">
              {pending} recordings waiting · {records.length - pending} saved on server
            </Text>
            {(!state.settings.endpoint || !state.hasSecret) && (
              <Button mode="contained" onPress={() => setTab('settings')}>
                Set up server connection
              </Button>
            )}
            {state.progress && (
              <SyncProgressView
                progress={state.progress}
                transfer={state.transfer}
                active={state.busy}
              />
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
                Import & upload
              </Button>
              <Button
                mode="outlined"
                disabled={busy || !state.settings.endpoint || !state.hasSecret}
                onPress={() => void action(() => client.syncCloud())}
              >
                Upload local audio
              </Button>
            </View>
            {!!state.uploadJobs?.length && (
              <View style={styles.jobs}>
                <Text variant="titleMedium">Transcription</Text>
                {state.uploadJobs.map((upload) => (
                  <View key={upload.id} style={styles.job}>
                    <Text variant="bodyMedium" selectable>
                      {upload.id.slice(0, 12)} ·{' '}
                      {upload.transcription
                        ? `${upload.transcription.status} · ${upload.transcription.stage} · ${Math.round(upload.transcription.progress * 100)}%`
                        : 'Not queued'}
                    </Text>
                    {!!upload.transcription?.error && (
                      <Text selectable style={{ color: theme.colors.error }}>
                        {upload.transcription.error}
                      </Text>
                    )}
                    {!!upload.backup_error && (
                      <Text selectable style={{ color: theme.colors.error }}>
                        Notion backup: {upload.backup_error}
                      </Text>
                    )}
                  </View>
                ))}
              </View>
            )}
            <Divider />
            <Text variant="titleLarge">Omi device</Text>
            {state.device ? (
              <>
                <List.Item
                  title={state.device.name}
                  description={`${state.device.address}${state.device.battery !== undefined ? ` · ${state.device.battery}% battery` : ''}`}
                />
                {!!state.device.warnings?.length && (
                  <List.Accordion title={`Device diagnostics (${state.device.warnings.length})`}>
                    {state.device.warnings.map((warning) => (
                      <Text
                        key={warning}
                        selectable
                        style={{ color: theme.colors.onSurfaceVariant }}
                      >
                        {warning}
                      </Text>
                    ))}
                  </List.Accordion>
                )}
                <View style={styles.actions}>
                  <Button disabled={busy} onPress={() => void action(() => client.importDevice())}>
                    Import only
                  </Button>
                  <Button disabled={busy} onPress={() => void action(() => client.unpair())}>
                    Disconnect
                  </Button>
                </View>
                <View style={styles.actions}>
                  <TextInput
                    mode="outlined"
                    label="Microphone gain (0–8)"
                    keyboardType="numeric"
                    style={styles.gain}
                    value={gain ?? String(state.device.micGain ?? '')}
                    onChangeText={setGain}
                  />
                  <Button
                    mode="outlined"
                    disabled={busy || !gain}
                    onPress={() =>
                      void action(async () => {
                        await client.micGain(Number(gain))
                        setGain(null)
                        setMessage('Microphone gain saved')
                      })
                    }
                  >
                    Apply gain
                  </Button>
                </View>
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
                void action(async () => {
                  const found = await client.scan()
                  setDevices(found)
                  if (!found.length)
                    setMessage('No Omi found. Check Bluetooth and move the device closer.')
                }).finally(() => setScanning(false))
              }}
            >
              Find Omi
            </Button>
            {devices.map((d) => (
              <List.Item
                key={d.address}
                title={d.name}
                description={d.address}
                disabled={busy}
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
            <Button
              disabled={busy || records.length === pending}
              onPress={() =>
                void action(async () => {
                  await client.clearDelivered()
                  setMessage('Saved local copies removed')
                })
              }
            >
              Remove saved local copies
            </Button>
            <Text variant="bodySmall">
              Removes local audio only after server storage is confirmed.
            </Text>
          </View>
        ) : (
          <View style={styles.section}>
            <Text variant="headlineMedium">Connect to Recorder</Text>
            <Text>Create an access key in Recorder → Devices.</Text>
            <TextInput
              mode="outlined"
              label="API upload URL"
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
            {draft.mode === 'periodic' && (
              <TextInput
                mode="outlined"
                label="Periodic interval (hours)"
                keyboardType="numeric"
                value={String(draft.intervalHours)}
                onChangeText={(v) => setDraft({ ...draft, intervalHours: Number(v) })}
              />
            )}
            <Text variant="bodySmall">
              {draft.mode === 'periodic'
                ? 'Syncs on Wi-Fi at the interval above.'
                : draft.mode === 'realtime'
                  ? 'Imports continuously while the background service runs.'
                  : 'Syncs when you press Import & upload.'}
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
  error: { gap: 8 },
  jobs: { gap: 12 },
  job: { gap: 4, minWidth: 0 },
  gain: { flexGrow: 1, minWidth: 180 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
})
