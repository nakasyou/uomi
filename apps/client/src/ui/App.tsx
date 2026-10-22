import { syncProgressText } from '../core/progress'
import { SyncEta, etaLabel } from '../core/eta'
import type { SyncProgress } from '../core/types'
import React, { memo, useEffect, useRef, useState, useMemo } from 'react'
import {
  View,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  useColorScheme,
  Platform,
  BackHandler,
  StatusBar,
  AppState,
  Linking,
} from 'react-native'
import {
  PaperProvider,
  MD3LightTheme,
  MD3DarkTheme,
  Text,
  Button,
  Icon,
  IconButton,
  TextInput,
  SegmentedButtons,
  Divider,
  Chip,
  ProgressBar,
  Snackbar,
  Switch,
  ActivityIndicator,
  HelperText,
  List,
  TouchableRipple,
  Dialog,
  Portal,
  useTheme,
} from 'react-native-paper'
import { MaterialDesignIcons } from '@react-native-vector-icons/material-design-icons'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { client } from '../platform/runtime'
import { notionId, type RemoteRecording } from '@uomi/notion'
import type { Snapshot, Settings, Device, Mode } from '../core/types'

import { DEFAULT_MIC_GAIN, MIC_GAIN_LABELS } from '../core/protocol'
import { planChunks, frameOffset, type ChunkPlan } from '../core/catalog'
import { audioChunks, chunkEndLabel, type AudioChunk } from '../core/segments'
import { startLiveAudio } from '../platform/live'
import { playAudio, stopPlayback } from '../platform/playback'

const destinations = [
  { key: 'library', label: 'Library', icon: 'tray-full' },
  { key: 'device', label: 'Devices', icon: 'bluetooth' },
  { key: 'settings', label: 'Settings', icon: 'tune-variant' },
] as const
type Page = (typeof destinations)[number]['key']
const modeLabel = {
  manual: 'Manual sync',
  realtime: 'Real-time sync',
  periodic: 'Periodic sync',
}
function duration(ms: number) {
  if (ms > 0 && ms < 1000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}
function date(value: string | null) {
  return value
    ? new Date(value).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : 'Not yet synced'
}

export default function App() {
  const dark = useColorScheme() === 'dark'
  const base = dark ? MD3DarkTheme : MD3LightTheme
  const theme = {
    ...base,
    colors: {
      ...base.colors,
      primary: dark ? '#a1d5ad' : '#326342',
      onPrimary: dark ? '#05391c' : '#ffffff',
      primaryContainer: dark ? '#234f31' : '#d3ead6',
      onPrimaryContainer: dark ? '#d3ead6' : '#102f1a',
      secondaryContainer: dark ? '#354b3b' : '#e4eddf',
      onSecondaryContainer: dark ? '#dce8d9' : '#354b3b',
      background: dark ? '#111712' : '#f8faf6',
      surface: dark ? '#111712' : '#f8faf6',
      surfaceVariant: dark ? '#303b31' : '#e4eae0',
      onSurface: dark ? '#e0e5dc' : '#202a22',
      onSurfaceVariant: dark ? '#bac7b8' : '#526051',
      outlineVariant: dark ? '#3e4b3e' : '#dce3d8',
    },
  }
  return (
    <SafeAreaProvider>
      <PaperProvider
        theme={theme}
        settings={{
          icon: (props) => <MaterialDesignIcons {...props} name={props.name as never} />,
        }}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
          <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
          <Shell />
        </SafeAreaView>
      </PaperProvider>
    </SafeAreaProvider>
  )
}
function Shell() {
  const { colors } = useTheme()
  const { width } = useWindowDimensions()
  const expanded = width >= 840
  const [page, setPage] = useState<Page>('library')
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null)
  useEffect(() => {
    scroll.current?.scrollTo({ y: 0, animated: false })
  }, [page])
  const [state, setState] = useState<Snapshot>(() => client.getSnapshot())
  const [message, setMessage] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [settingsDirty, setSettingsDirty] = useState(false)
  const [confirmExit, setConfirmExit] = useState(false)
  useEffect(() => {
    const unsub = client.subscribe(() => setState(client.getSnapshot()))
    void client
      .init()
      .then(() => {
        setState(client.getSnapshot())
        setLoaded(true)
      })
      .catch((e) => {
        setMessage(String(e.message ?? e))
        setLoaded(true)
      })
    return unsub
  }, [])
  useEffect(() => {
    if (Platform.OS === 'web') return
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (page !== 'library') {
        setPage('library')
        return true
      }
      if (settingsDirty) {
        setConfirmExit(true)
        return true
      }
      return false
    })
    return () => sub.remove()
  }, [page, settingsDirty])
  const action = async (fn: () => Promise<unknown>, success?: string) => {
    try {
      await fn()
      if (success) setMessage(success)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    }
  }
  useEffect(() => {
    if (Platform.OS !== 'web' || !settingsDirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [settingsDirty])
  return (
    <View style={styles.shell}>
      {expanded ? (
        <View style={[styles.rail, { borderRightColor: colors.outlineVariant }]}>
          <View style={styles.brand}>
            <Icon source="waveform" size={30} />
            <Text variant="titleLarge" style={{ fontWeight: '700' }}>
              uomi
            </Text>
          </View>
          <View style={{ gap: 12, marginTop: 48 }}>
            {destinations.map((d) => (
              <Nav
                key={d.key}
                label={d.label}
                icon={d.icon}
                selected={page === d.key}
                onPress={() => setPage(d.key)}
              />
            ))}
          </View>
          <View style={{ flex: 1 }} />
          <View style={styles.railFooter}>
            <Icon source="shield-lock-outline" size={19} />
            <Text variant="labelMedium">Local by default.</Text>
          </View>
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={[styles.topbar, !expanded && { paddingHorizontal: 20 }]}>
          <Text variant="labelLarge" style={{ opacity: 0.75 }}>
            {expanded ? destinations.find((d) => d.key === page)?.label : 'uomi'}
            {settingsDirty ? ' · Settings not saved' : ''}
          </Text>
          <View style={styles.row}>
            <Icon source={state.wifi ? 'wifi' : 'wifi-off'} size={18} />
            <Text variant="labelMedium">{state.wifi ? 'Wi-Fi connected' : 'No Wi-Fi'}</Text>
          </View>
        </View>
        <ScrollView
          ref={scroll}
          contentContainerStyle={[styles.content, { paddingHorizontal: expanded ? 48 : 24 }]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ width: '100%', maxWidth: 1000, alignSelf: 'center' }}>
            {!loaded ? (
              <View style={{ marginTop: 80, alignItems: 'center', gap: 16 }}>
                <ActivityIndicator />
                <Text>
                  Loading saved recordings
                  {state.loadingRecords === undefined
                    ? '…'
                    : ` · ${state.loadingRecords.toLocaleString()} loaded`}
                </Text>
              </View>
            ) : page === 'library' ? (
              <Library
                state={state}
                onDevice={() => setPage('device')}
                onSettings={() => setPage('settings')}
                action={action}
              />
            ) : page === 'device' ? (
              <DeviceScreen state={state} action={action} onSettings={() => setPage('settings')} />
            ) : null}
            {/* Keep the form mounted: drafts and unsaved secrets stay in memory across tabs. */}
            {loaded ? (
              <View style={page === 'settings' ? undefined : { display: 'none' }}>
                <SettingsScreen state={state} action={action} onDirtyChange={setSettingsDirty} />
              </View>
            ) : null}
          </View>
        </ScrollView>
        {!expanded ? (
          <View style={[styles.bottomNav, { borderTopColor: colors.outlineVariant }]}>
            {destinations.map((d) => (
              <Nav
                key={d.key}
                label={d.label}
                icon={d.icon}
                selected={page === d.key}
                onPress={() => setPage(d.key)}
                compact
              />
            ))}
          </View>
        ) : null}
      </View>
      <Portal>
        <Dialog visible={confirmExit} onDismiss={() => setConfirmExit(false)}>
          <Dialog.Title>Close with unsaved settings?</Dialog.Title>
          <Dialog.Content>
            <Text>
              Your draft stays while the app is open. Closing now will lose unsaved settings.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button
              onPress={() => {
                setConfirmExit(false)
                setPage('settings')
              }}
            >
              Keep editing
            </Button>
            <Button onPress={() => BackHandler.exitApp()}>Close app</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
      <Snackbar
        visible={!!message}
        onDismiss={() => setMessage('')}
        duration={7000}
        action={{ label: 'Dismiss', onPress: () => setMessage('') }}
      >
        {message}
      </Snackbar>
    </View>
  )
}
type Action = (fn: () => Promise<unknown>, success?: string) => Promise<void>
function Nav({
  label,
  icon,
  selected,
  onPress,
  compact = false,
}: {
  label: string
  icon: string
  selected: boolean
  onPress: () => void
  compact?: boolean
}) {
  const { colors } = useTheme()
  return (
    <TouchableRipple
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      style={{ borderRadius: 16, minHeight: 64, flex: compact ? 1 : undefined }}
    >
      <View style={[styles.navItem, compact && { alignItems: 'center', paddingHorizontal: 8 }]}>
        <View
          pointerEvents="none"
          style={{
            minWidth: 56,
            height: 34,
            borderRadius: 16,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: selected ? colors.primaryContainer : 'transparent',
          }}
        >
          <Icon
            source={icon}
            size={22}
            color={selected ? colors.onPrimaryContainer : colors.onSurfaceVariant}
          />
        </View>
        <Text variant="labelMedium">{label}</Text>
      </View>
    </TouchableRipple>
  )
}
// Progress updates must not rebuild the recording rows. Keep each page
// bounded as a library can contain thousands of device packets.
const RecordingRows = memo(function RecordingRows({ chunks }: { chunks: AudioChunk[] }) {
  const [page, setPage] = useState(0)
  const [playing, setPlaying] = useState<string | null>(null)
  const [playbackError, setPlaybackError] = useState('')
  const [playbackSeconds, setPlaybackSeconds] = useState(0)
  const playRequest = useRef(0)
  useEffect(
    () => () => {
      playRequest.current++
      stopPlayback()
    },
    [],
  )
  const play = async (record: AudioChunk) => {
    const request = ++playRequest.current
    stopPlayback()
    if (playing === record.key) {
      setPlaying(null)
      return
    }
    setPlaybackError('')
    setPlaying(record.key)
    try {
      const frames = record.segment.frames
      setPlaybackSeconds(frames.reduce((n, f) => n + f.durationMs, 0) / 1000)
      await playAudio(frames)
    } catch (error) {
      if (playRequest.current === request)
        setPlaybackError(error instanceof Error ? error.message : String(error))
    } finally {
      if (playRequest.current === request) setPlaying(null)
    }
  }
  const pageSize = 50
  const lastPage = Math.max(0, Math.ceil(chunks.length / pageSize) - 1)
  const currentPage = Math.min(page, lastPage)
  const visible = chunks.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
  return (
    <View>
      {playing ? (
        <View style={styles.rowBetween}>
          <Text variant="bodyMedium">Playing · {playbackSeconds.toFixed(1)}s chunk</Text>
          <Button
            icon="stop"
            onPress={() => {
              playRequest.current++
              stopPlayback()
              setPlaying(null)
            }}
          >
            Stop
          </Button>
        </View>
      ) : null}
      {playbackError ? (
        <Text accessibilityRole="alert" style={{ marginVertical: 12 }}>
          {playbackError}
        </Text>
      ) : null}
      {visible.map((r) => {
        const ms = r.segment.durationMs
        const sent = r.deliveredFrames === r.segment.frames.length
        return (
          <View key={r.key}>
            <View style={[styles.row, { paddingVertical: 20, flexWrap: 'wrap' }]}>
              <View style={styles.audioIcon}>
                <Icon source="waveform" size={25} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text variant="titleSmall">
                  {r.segment.frames[0]?.capturedAt
                    ? date(r.segment.frames[0]?.capturedAt)
                    : 'Recording · device clock unset'}
                </Text>
                <Text variant="bodySmall" style={[styles.subtle, { marginTop: 4 }]}>
                  {duration(ms)} · Opus · {r.segment.deviceId}
                </Text>
                <Text variant="bodySmall" style={[styles.subtle, { marginTop: 4 }]}>
                  Ends here: {chunkEndLabel(r.endReason)}
                </Text>
                {r.timestampGaps.count > 0 ? (
                  <Text variant="bodySmall" style={[styles.subtle, { marginTop: 4 }]}>
                    {r.timestampGaps.count} device timestamp{' '}
                    {r.timestampGaps.count === 1 ? 'gap' : 'gaps'} · about{' '}
                    {(r.timestampGaps.approximateMs / 1000).toFixed(1)}s total. Saved audio plays
                    continuously; no silence is added.
                  </Text>
                ) : null}
              </View>
              <IconButton
                icon={playing === r.key ? 'stop' : 'play'}
                accessibilityLabel={playing === r.key ? 'Stop playback' : 'Play this audio chunk'}
                onPress={() => void play(r)}
                style={{ minWidth: 48, minHeight: 48 }}
              />
              <Chip icon={sent ? 'check' : 'clock-outline'} compact>
                {sent ? 'Saved in Notion' : r.deliveredFrames > 0 ? 'Partly synced' : 'Local only'}
              </Chip>
            </View>
            <Divider />
          </View>
        )
      })}
      {lastPage > 0 ? (
        <View style={[styles.rowBetween, { marginTop: 16, flexWrap: 'wrap' }]}>
          <Button disabled={currentPage === 0} onPress={() => setPage(currentPage - 1)}>
            Previous
          </Button>
          <Text variant="labelMedium">
            {currentPage * pageSize + 1}–{Math.min((currentPage + 1) * pageSize, chunks.length)} of{' '}
            {chunks.length}
          </Text>
          <Button disabled={currentPage === lastPage} onPress={() => setPage(currentPage + 1)}>
            Next
          </Button>
        </View>
      ) : null}
    </View>
  )
})

const CatalogRows = memo(function CatalogRows({ plans }: { plans: ChunkPlan[] }) {
  const [page, setPage] = useState(0)
  const [playing, setPlaying] = useState<string | null>(null)
  const [error, setError] = useState('')
  const request = useRef(0)
  useEffect(
    () => () => {
      request.current++
      stopPlayback()
    },
    [],
  )
  const current = Math.min(page, Math.max(0, Math.ceil(plans.length / 50) - 1))
  return (
    <View>
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      {plans.slice(current * 50, (current + 1) * 50).map((plan) => (
        <View key={plan.key}>
          <View style={[styles.row, { paddingVertical: 20 }]}>
            <Icon source="waveform" size={25} />
            <View style={{ flex: 1 }}>
              <Text variant="titleSmall">
                {plan.capturedAt ? date(plan.capturedAt) : 'Recording · device clock unset'}
              </Text>
              <Text variant="bodySmall" style={[styles.subtle, { marginTop: 4 }]}>
                {duration(plan.durationMs)} · Opus · {plan.deviceId}
              </Text>
              <Text variant="bodySmall" style={[styles.subtle, { marginTop: 4 }]}>
                {plan.sourceFrames.toLocaleString()} audio frames · {chunkEndLabel(plan.endReason)}
              </Text>
              {plan.ranges.some((range) => range.gapMs > 0) ? (
                <Text variant="bodySmall" style={styles.subtle}>
                  Nearby audio combined with silent gaps. Original Opus is preserved.
                </Text>
              ) : null}
            </View>
            <IconButton
              icon={playing === plan.key ? 'stop' : 'play'}
              accessibilityLabel={playing === plan.key ? 'Stop playback' : 'Play this audio chunk'}
              onPress={() => {
                const id = ++request.current
                stopPlayback()
                setError('')
                if (playing === plan.key) {
                  setPlaying(null)
                  return
                }
                setPlaying(plan.key)
                void (async () => {
                  try {
                    const frames = await client.loadLocalChunk(plan)
                    if (request.current === id) await playAudio(frames)
                  } catch (e) {
                    if (request.current === id) setError(e instanceof Error ? e.message : String(e))
                  } finally {
                    if (request.current === id) setPlaying(null)
                  }
                })()
              }}
            />
            <Chip compact>
              {plan.deliveredFrames === plan.sourceFrames ? 'Saved in Notion' : 'Local only'}
            </Chip>
          </View>
          <Divider />
        </View>
      ))}
      {plans.length > 50 ? (
        <View style={[styles.rowBetween, { marginTop: 16 }]}>
          <Button disabled={current === 0} onPress={() => setPage(current - 1)}>
            Previous
          </Button>
          <Text>
            {current * 50 + 1}–{Math.min(plans.length, (current + 1) * 50)} of {plans.length}
          </Text>
          <Button
            disabled={(current + 1) * 50 >= plans.length}
            onPress={() => setPage(current + 1)}
          >
            Next
          </Button>
        </View>
      ) : null}
    </View>
  )
})

function retentionSummary(settings: Settings) {
  return settings.deleteAfterUpload === false
    ? 'Local copies will stay on this device after sync.'
    : 'After the Notion copy is verified, local copies are removed. The original audio stays in Notion.'
}

function Library({
  state,
  onDevice,
  onSettings,
  action,
}: {
  state: Snapshot
  onDevice: () => void
  onSettings: () => void
  action: Action
}) {
  const [confirm, setConfirm] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [storage, setStorage] = useState(
    state.settings.notionSource || state.remoteRecordings.length ? 'notion' : 'local',
  )
  useEffect(() => {
    if (!state.settings.notionSource || !state.hasSecret) return
    const timer = setTimeout(() => {
      void action(() => client.searchRemote(query))
    }, 300)
    return () => clearTimeout(timer)
  }, [query, state.settings.notionSource, state.hasSecret])
  const chunks = useMemo(
    () => [...audioChunks(state.recordings, state.settings.segmentSeconds)].reverse(),
    [state.recordings, state.settings.segmentSeconds],
  )
  const plans = useMemo(
    () =>
      state.localPlans
        ? [...state.localPlans].reverse()
        : state.catalog
          ? [...planChunks(state.catalog, state.settings.segmentSeconds)].reverse()
          : undefined,
    [state.localPlans, state.catalog, state.settings.segmentSeconds],
  )
  const localCount = plans?.length ?? chunks.length
  const saved = plans
    ? plans.filter((plan) => plan.deliveredFrames === plan.sourceFrames).length
    : chunks.filter((c) => c.deliveredFrames === c.segment.frames.length).length
  const remote = useMemo(
    () =>
      [...state.remoteRecordings].sort((a, b) =>
        (b.capturedAt ?? '').localeCompare(a.capturedAt ?? ''),
      ),
    [state.remoteRecordings],
  )
  const matching = useMemo(
    () =>
      remote.filter(
        (r) =>
          (filter === 'all' ||
            (filter === 'completed' ? r.status === 'Completed' : r.status !== 'Completed')) &&
          `${r.transcript} ${r.deviceId} ${date(r.capturedAt)}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [remote, filter, query],
  )
  return (
    <View>
      <View style={styles.heading}>
        <Text variant="headlineLarge">Your recordings, with the words.</Text>
        <Text variant="bodyLarge" style={styles.subtle}>
          Listen to original audio. Find the conversation in Notion.
        </Text>
      </View>
      <View style={[styles.rowBetween, { flexWrap: 'wrap', marginBottom: 24 }]}>
        <Text variant="bodyMedium">
          {localCount} local · {remote.length}
          {state.remoteHasMore ? '+' : ''} in Notion ·{' '}
          {remote.filter((r) => r.status === 'Completed').length} transcribed
        </Text>
        <Button mode="contained-tonal" icon="bluetooth" onPress={onDevice}>
          Sync in Devices
        </Button>
      </View>
      <SegmentedButtons
        value={storage}
        onValueChange={setStorage}
        style={{ marginBottom: 24 }}
        buttons={[
          { value: 'notion', label: 'In Notion', style: { minHeight: 48 } },
          { value: 'local', label: 'On this device', style: { minHeight: 48 } },
        ]}
      />
      {storage === 'local' ? (
        <View>
          <Text variant="titleLarge">Saved on this device</Text>
          <Text variant="bodyMedium" style={[styles.subtle, { marginTop: 8, marginBottom: 16 }]}>
            {retentionSummary(state.settings)}
          </Text>
          <Divider />
          {localCount ? (
            plans ? (
              <CatalogRows plans={plans} />
            ) : (
              <RecordingRows chunks={chunks} />
            )
          ) : (
            <View style={styles.empty}>
              <Icon source="waveform" size={40} />
              <Text variant="titleMedium" style={{ marginTop: 16 }}>
                Your first recording starts in Devices.
              </Text>
              <Button onPress={onDevice} style={{ marginTop: 12 }}>
                Connect or sync Omi
              </Button>
            </View>
          )}
          {saved > 0 ? (
            <Button
              icon="delete-outline"
              disabled={state.busy}
              onPress={() => setConfirm(true)}
              style={{ alignSelf: 'flex-start', marginTop: 16 }}
            >
              Delete local copies saved in Notion
            </Button>
          ) : null}
        </View>
      ) : (
        <View>
          <View style={[styles.rowBetween, { flexWrap: 'wrap' }]}>
            <Text variant="titleLarge">In Notion</Text>
            <Button
              icon="refresh"
              loading={state.checkingNotion}
              disabled={
                state.busy ||
                state.checkingNotion ||
                !state.settings.notionSource ||
                !state.hasSecret
              }
              onPress={() => void action(() => client.refreshNotion())}
            >
              Refresh transcripts
            </Button>
          </View>
          {remote.length ||
          state.remoteHasMore ||
          state.remoteHasPrevious ||
          query ||
          filter !== 'all' ? (
            <>
              <TextInput
                mode="outlined"
                accessibilityLabel="Search cached transcripts"
                label="Search cached transcripts"
                value={query}
                onChangeText={setQuery}
                style={{ marginTop: 16, marginBottom: 16 }}
              />
              <SegmentedButtons
                value={filter}
                onValueChange={setFilter}
                buttons={[
                  { value: 'all', label: 'All' },
                  { value: 'completed', label: 'Transcribed' },
                  { value: 'pending', label: 'Needs processing' },
                ]}
              />
            </>
          ) : null}
          {!matching.length ? (
            <Text variant="bodyMedium" style={[styles.subtle, { marginVertical: 24 }]}>
              {query || filter !== 'all'
                ? 'No recordings match this search. Try another search or choose All.'
                : 'Sync recordings to Notion from Devices. Their processing status and transcripts will appear here.'}
            </Text>
          ) : null}
          {!remote.length && !query && filter === 'all' ? (
            <Button
              mode="contained-tonal"
              onPress={state.settings.notionSource && state.hasSecret ? onDevice : onSettings}
              style={{ alignSelf: 'flex-start', marginBottom: 16 }}
            >
              {state.settings.notionSource && state.hasSecret
                ? 'Sync recordings in Devices'
                : 'Set up Notion'}
            </Button>
          ) : null}
          <NotionRows recordings={matching} action={action} />
          {state.remoteHasPrevious || state.remoteHasMore ? (
            <View style={[styles.rowBetween, { marginTop: 16, flexWrap: 'wrap' }]}>
              <Button
                disabled={!state.remoteHasPrevious}
                onPress={() => void action(() => client.previousRemote())}
              >
                Newer recordings
              </Button>
              <Text>Notion page {state.remotePage ?? 1}</Text>
              <Button
                disabled={!state.remoteHasMore}
                onPress={() => void action(() => client.moreRemote())}
              >
                Older recordings
              </Button>
            </View>
          ) : null}
        </View>
      )}
      <Portal>
        <Dialog visible={confirm} onDismiss={() => setConfirm(false)}>
          <Dialog.Title>Delete local copies?</Dialog.Title>
          <Dialog.Content>
            <Text>
              Only audio acknowledged as saved in your current Notion destination is removed from
              this client. Unsynced audio and Notion files are kept.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirm(false)}>Cancel</Button>
            <Button
              onPress={() => {
                setConfirm(false)
                void action(() => client.clearDelivered(), 'Local copies deleted.')
              }}
            >
              Delete local copies
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  )
}
function NotionRows({ recordings, action }: { recordings: RemoteRecording[]; action: Action }) {
  const [limit, setLimit] = useState(20)
  const [texts, setTexts] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const playbackRequest = useRef(0)
  useEffect(
    () => () => {
      stopPlayback()
    },
    [],
  )
  return (
    <View>
      {recordings.slice(0, limit).map((record) => (
        <View key={record.id} style={{ paddingVertical: 24 }}>
          <View style={[styles.rowBetween, { flexWrap: 'wrap', alignItems: 'flex-start' }]}>
            <View style={{ flex: 1, minWidth: 160 }}>
              <Text variant="titleMedium">{date(record.capturedAt)}</Text>
              <Text variant="bodySmall" style={[styles.subtle, { marginTop: 6 }]}>
                {duration(record.durationMs)} · {record.deviceId}
              </Text>
            </View>
            <Chip
              icon={
                record.status === 'Completed'
                  ? 'text-box-check-outline'
                  : record.status === 'Failed'
                    ? 'alert-circle-outline'
                    : 'clock-outline'
              }
            >
              {record.status === 'Completed'
                ? 'Transcribed'
                : record.status === 'Pending'
                  ? 'Awaiting transcription'
                  : record.status}
            </Chip>
          </View>
          <Text variant="labelMedium" style={{ marginTop: 12 }}>
            Saved in Notion
          </Text>
          <Text
            selectable
            variant="bodyMedium"
            numberOfLines={expanded === record.id ? undefined : 4}
            style={{ marginTop: 10, lineHeight: 24 }}
          >
            {texts[record.id] ?? record.transcript ?? ''}
          </Text>
          {!record.transcript && record.status !== 'Completed' ? (
            <Text variant="bodyMedium" style={styles.subtle}>
              The audio is saved. Your transcriber will add the words here.
            </Text>
          ) : null}
          {record.status === 'Completed' && !record.transcript ? (
            <Text variant="bodyMedium" style={styles.subtle}>
              No speech text returned.
            </Text>
          ) : null}
          {record.error || record.notificationError ? (
            <Text accessibilityRole="alert" variant="bodyMedium" style={{ marginTop: 12 }}>
              {record.notificationError || record.error}
            </Text>
          ) : null}
          <View style={[styles.row, { flexWrap: 'wrap', marginTop: 12 }]}>
            {record.status === 'Completed' ? (
              <Button
                loading={loading === record.id}
                disabled={loading !== null}
                onPress={() =>
                  void action(async () => {
                    if (expanded === record.id) {
                      setExpanded(null)
                      return
                    }
                    setLoading(record.id)
                    try {
                      const text = await client.loadTranscript(record.pageId)
                      setTexts((t) => ({ ...t, [record.id]: text }))
                      setExpanded(record.id)
                    } finally {
                      setLoading(null)
                    }
                  })
                }
              >
                {expanded === record.id ? 'Collapse' : 'Read transcript'}
              </Button>
            ) : (
              <Button
                icon="send-outline"
                onPress={() =>
                  void action(
                    () => client.retryTranscription(record.pageId),
                    'Notification retried. Refresh to check progress.',
                  )
                }
              >
                Notify transcriber
              </Button>
            )}
            <Button
              icon={playing === record.id ? 'stop' : 'play'}
              onPress={() =>
                void action(async () => {
                  const request = ++playbackRequest.current
                  stopPlayback()
                  if (playing === record.id) {
                    setPlaying(null)
                    return
                  }
                  setPlaying(record.id)
                  try {
                    const frames = await client.loadRemoteAudio(record.pageId)
                    if (playbackRequest.current === request) await playAudio(frames)
                  } finally {
                    if (playbackRequest.current === request) setPlaying(null)
                  }
                })
              }
            >
              {playing === record.id ? 'Stop' : 'Play saved audio'}
            </Button>
            <Button
              icon="open-in-new"
              onPress={() => void action(() => Linking.openURL(record.url))}
            >
              Open in Notion
            </Button>
          </View>
          <Divider style={{ marginTop: 20 }} />
        </View>
      ))}
      {recordings.length > limit ? (
        <Button onPress={() => setLimit((n) => n + 20)}>Show more recordings</Button>
      ) : null}
    </View>
  )
}
function SyncRemaining({ progress }: { progress: SyncProgress | null }) {
  const estimator = useRef(new SyncEta())
  const [label, setLabel] = useState('Estimating…')
  useEffect(() => {
    const update = () => setLabel(etaLabel(estimator.current.remaining(progress, Date.now())))
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [progress])
  return (
    <Text variant="bodySmall" style={{ marginTop: 4 }}>
      {label}
    </Text>
  )
}
function DeviceSync({
  state,
  action,
  onSettings,
}: {
  state: Snapshot
  action: Action
  onSettings: () => void
}) {
  const { colors } = useTheme()
  const active = state.busy || state.checkingNotion
  const progress = state.progress
  const progressText = syncProgressText(progress)

  const pendingMs = useMemo(
    () =>
      state.catalog
        ? state.catalog.reduce((n, r) => n + r.durationMs - frameOffset(r, r.uploaded), 0)
        : state.recordings.reduce(
            (n, r) => n + r.frames.slice(r.uploaded).reduce((a, f) => a + f.durationMs, 0),
            0,
          ),
    [state.recordings, state.catalog],
  )
  return (
    <View
      style={[styles.syncSurface, { backgroundColor: colors.elevation.level1, marginBottom: 28 }]}
    >
      <View style={[styles.rowBetween, { flexWrap: 'wrap' }]}>
        <Chip icon="sync">{modeLabel[state.settings.mode]}</Chip>
        <Text variant="labelMedium">
          Last import · {state.lastDeviceSync ? date(state.lastDeviceSync) : 'Not imported yet'}
        </Text>
      </View>
      <Text variant="headlineSmall" style={{ marginTop: 20 }}>
        {active
          ? state.phase
          : pendingMs
            ? `${duration(pendingMs)} ready for Notion`
            : 'Bring your recordings home.'}
      </Text>
      <Text variant="bodyMedium" style={[styles.subtle, { marginTop: 10, lineHeight: 22 }]}>
        Import recordings from Omi, then sync them to Notion when you choose.{' '}
        {retentionSummary(state.settings)}
      </Text>
      <View style={{ height: 4, overflow: 'hidden', marginTop: 24 }}>
        <ProgressBar
          visible={active}
          indeterminate={!progress || progress.total === 0}
          progress={state.progress?.total ? state.progress.completed / state.progress.total : 0}
        />
      </View>
      <Text
        accessibilityLiveRegion="polite"
        variant="labelMedium"
        style={{ marginTop: 8, minHeight: 20 }}
      >
        {active ? progressText : ' '}
      </Text>
      {active &&
      progress &&
      progress.total > 0 &&
      (progress.stage === 'import' || progress.stage === 'upload') ? (
        <SyncRemaining progress={progress} />
      ) : null}
      {state.transfer && state.transfer.elapsedMs > 0 ? (
        <View style={{ marginTop: 6, gap: 3 }}>
          <Text variant="bodySmall">
            {progress?.stage !== 'import' ? 'Last Omi import · ' : ''}
            {((state.transfer.completed * 1000) / state.transfer.elapsedMs).toFixed(0)} packets/s
            {' · '}
            {(((state.transfer.receivedBytes / state.transfer.elapsedMs) * 1000) / 1024).toFixed(
              1,
            )}{' '}
            KiB/s
            {' · '}Storage{' '}
            {Math.min(100, Math.round((state.transfer.storageMs / state.transfer.elapsedMs) * 100))}
            % of elapsed time
          </Text>
          <Text variant="bodySmall">
            {state.transfer.mtu
              ? `MTU ${state.transfer.mtu}`
              : `MTU ≥ ${state.transfer.maxNotificationBytes + 3} (observed)`}
            {' · '}
            {state.transfer.rxPhy
              ? `Receive PHY ${state.transfer.rxPhy === 2 ? '2M' : state.transfer.rxPhy === 1 ? '1M' : 'Coded'}`
              : 'PHY managed by the OS'}
            {state.transfer.connectionIntervalMs
              ? ` · Interval ${state.transfer.connectionIntervalMs}ms`
              : ''}
          </Text>
        </View>
      ) : null}
      {state.storageMigrationError ? (
        <Text variant="bodySmall" style={{ marginTop: 8 }}>
          {state.storageMigrationError}
        </Text>
      ) : null}
      {active && progress?.pipeline ? (
        <View style={{ gap: 12, marginTop: 8 }}>
          {(['prepare', 'audio', 'metadata', 'attach'] as const).map((stage) => {
            const queue = progress.pipeline![stage]
            const labels = {
              prepare: 'Preparing',
              audio: 'Uploading audio',
              metadata: 'Uploading audio metadata',
              attach: 'Attaching files to Notion',
            }
            const reached = progress.chunksTotal ?? queue.completed + queue.active + queue.queued
            return (
              <View key={stage} style={{ gap: 5 }}>
                <View style={[styles.rowBetween, { flexWrap: 'wrap', gap: 4 }]}>
                  <Text variant="labelMedium">
                    {labels[stage]}
                    {stage === 'prepare' && progress.chunksTotal !== undefined
                      ? ` · ${queue.completed} / ${progress.chunksTotal} chunks`
                      : ''}
                  </Text>
                  <Text variant="labelSmall">
                    {queue.active} / 2 active · {queue.queued} queued · {queue.completed} done
                  </Text>
                </View>
                <ProgressBar
                  progress={reached ? queue.completed / reached : 0}
                  indeterminate={!progress.chunksTotal && queue.active > 0 && queue.completed === 0}
                />
              </View>
            )
          })}
        </View>
      ) : null}
      <View style={[styles.row, { flexWrap: 'wrap', marginTop: 16 }]}>
        <Button
          mode="contained-tonal"
          icon="bluetooth"
          disabled={state.busy || state.checkingNotion || !state.settings.deviceAddress}
          contentStyle={{ minHeight: 48 }}
          onPress={() => void action(() => client.importDevice())}
        >
          Import from Omi
        </Button>
        <Button
          mode="contained"
          icon="cloud-upload-outline"
          disabled={
            state.busy || state.checkingNotion || !state.settings.notionSource || !state.hasSecret
          }
          loading={state.checkingNotion}
          contentStyle={{ minHeight: 48 }}
          onPress={() => void action(() => client.syncNotion())}
        >
          Sync to Notion
        </Button>
      </View>
      <Text variant="bodySmall" style={[styles.subtle, { marginTop: 12 }]}>
        Last Notion sync · {date(state.lastSync)}
      </Text>
      <Text variant="bodySmall" style={[styles.subtle, { marginTop: 8 }]}>
        Notion sync sends locally saved audio and refreshes transcripts. Omi does not need to be
        connected. Automatic modes still run both stages.
      </Text>
      {!state.settings.notionSource || !state.hasSecret ? (
        <View style={{ alignItems: 'flex-start', marginTop: 12 }}>
          <Text variant="bodySmall">
            Notion is optional. You can import and listen to device audio without it.
          </Text>
          <Button contentStyle={{ minHeight: 48 }} onPress={onSettings}>
            Set up Notion
          </Button>
        </View>
      ) : null}
      {state.error ? (
        <View
          accessibilityRole="alert"
          style={[styles.notice, { backgroundColor: colors.errorContainer }]}
        >
          <Text style={{ color: colors.onErrorContainer, flex: 1 }}>{state.error}</Text>
        </View>
      ) : null}
    </View>
  )
}
function LiveMonitor({ disabled }: { disabled: boolean }) {
  const [status, setStatus] = useState<'idle' | 'connecting' | 'listening'>('idle')
  const [error, setError] = useState('')
  const [received, setReceived] = useState(0)
  const session = useRef(0)
  const frameCount = useRef(0)
  const sink = useRef<Awaited<ReturnType<typeof startLiveAudio>> | null>(null)
  const stop = async () => {
    session.current++
    sink.current?.stop()
    sink.current = null
    setStatus('idle')
    try {
      await client.stopMonitor()
    } catch (e) {
      setError(String(e))
    }
  }
  useEffect(() => {
    const tick = setInterval(() => setReceived(frameCount.current), 500)
    const appState = AppState.addEventListener('change', (value) => {
      if (value !== 'active') void stop()
    })
    const hidden = () => {
      if (document.hidden) void stop()
    }
    if (Platform.OS === 'web') document.addEventListener('visibilitychange', hidden)
    return () => {
      clearInterval(tick)
      appState.remove()
      if (Platform.OS === 'web') document.removeEventListener('visibilitychange', hidden)
      session.current++
      sink.current?.stop()
      sink.current = null
      void client.stopMonitor().catch(() => {})
    }
  }, [])
  const start = async () => {
    const request = ++session.current
    setStatus('connecting')
    setError('')
    setReceived(0)
    frameCount.current = 0
    stopPlayback()
    try {
      const player = await startLiveAudio((e) => {
        if (session.current === request) {
          void stop()
          setError(e.message)
        }
      })
      if (session.current !== request) {
        player.stop()
        return
      }
      sink.current = player
      await client.startMonitor((frame) => {
        frameCount.current++
        player.push(frame)
      })
      if (session.current !== request) {
        player.stop()
        return
      }
      setStatus('listening')
    } catch (e) {
      if (session.current === request) {
        sink.current?.stop()
        sink.current = null
        setStatus('idle')
        setError(e instanceof Error ? e.message : String(e))
      }
    }
  }
  return (
    <View style={{ marginTop: 28, gap: 12 }}>
      <Text variant="titleLarge">Live audio monitor</Text>
      <Text variant="bodyMedium" style={styles.subtle}>
        Debug audio from your Omi, played through this device. Nothing is saved or sent to your
        webhook. Stock firmware may not save audio on Omi while monitoring. Sync is paused until you
        stop.
      </Text>
      <View style={[styles.row, { flexWrap: 'wrap' }]}>
        <Button
          mode="contained-tonal"
          icon={status === 'idle' ? 'headphones' : 'stop'}
          disabled={disabled && status === 'idle'}
          loading={status === 'connecting'}
          onPress={() => void (status === 'idle' ? start() : stop())}
          contentStyle={{ minHeight: 48 }}
        >
          {status === 'idle' ? 'Start listening' : 'Stop listening'}
        </Button>
        <Text variant="bodySmall">
          {status === 'connecting'
            ? 'Connecting…'
            : status === 'listening'
              ? `${received} audio frames received · short playback delay`
              : 'Stopped'}
        </Text>
      </View>
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
    </View>
  )
}

function MicrophoneGain({ state, action }: { state: Snapshot; action: Action }) {
  const actual = state.device?.micGain
  const [level, setLevel] = useState(actual ?? DEFAULT_MIC_GAIN)
  useEffect(() => {
    setLevel(actual ?? DEFAULT_MIC_GAIN)
  }, [actual, state.settings.deviceAddress])
  return (
    <View style={{ marginTop: 28, gap: 12 }}>
      <Text variant="titleLarge">Microphone gain</Text>
      <Text variant="bodyMedium">
        {actual === undefined
          ? 'Device setting not read yet'
          : `On Omi: level ${actual} · ${MIC_GAIN_LABELS[actual]}`}
      </Text>
      <Text variant="bodySmall" style={styles.subtle}>
        Firmware default: level 6 (+20 dB). Changes apply to the Omi microphone, including future
        recordings, and are saved by its firmware. Existing recordings are unchanged.
      </Text>
      <View style={[styles.row, { flexWrap: 'wrap' }]}>
        <IconButton
          icon="minus"
          accessibilityLabel="Decrease microphone gain"
          disabled={state.busy || level === 0}
          onPress={() => setLevel(level - 1)}
          style={{ minWidth: 48, minHeight: 48 }}
        />
        <Text variant="titleMedium">
          Level {level} · {MIC_GAIN_LABELS[level]}
        </Text>
        <IconButton
          icon="plus"
          accessibilityLabel="Increase microphone gain"
          disabled={state.busy || level === 8}
          onPress={() => setLevel(level + 1)}
          style={{ minWidth: 48, minHeight: 48 }}
        />
      </View>
      <View style={[styles.row, { flexWrap: 'wrap' }]}>
        <Button
          mode="contained-tonal"
          disabled={state.busy}
          onPress={() => void action(() => client.micGain(level), 'Microphone gain applied.')}
        >
          Apply gain
        </Button>
        <Button disabled={state.busy} onPress={() => void action(() => client.micGain())}>
          Read from Omi
        </Button>
        <Button
          disabled={state.busy}
          onPress={() =>
            void action(async () => {
              await client.micGain(DEFAULT_MIC_GAIN)
              setLevel(DEFAULT_MIC_GAIN)
            }, 'Default gain applied: level 6 (+20 dB).')
          }
        >
          Use default
        </Button>
      </View>
    </View>
  )
}

function DeviceScreen({
  state,
  action,
  onSettings,
}: {
  state: Snapshot
  action: Action
  onSettings: () => void
}) {
  const { colors } = useTheme()
  const [searched, setSearched] = useState(false)
  const [devices, setDevices] = useState<Device[]>([])
  const [scanning, setScanning] = useState(false)
  const [pairing, setPairing] = useState(false)
  const scan = () =>
    action(async () => {
      setScanning(true)
      try {
        setDevices(await client.scan())
        setSearched(true)
      } finally {
        setScanning(false)
      }
    })
  return (
    <View>
      <View style={styles.heading}>
        <Text variant="headlineLarge">Devices & sync.</Text>
        <Text variant="bodyLarge" style={styles.subtle}>
          A direct connection to your recordings.
        </Text>
      </View>
      {state.settings.deviceAddress ? (
        <DeviceSync state={state} action={action} onSettings={onSettings} />
      ) : null}
      {state.settings.deviceAddress ? (
        <View
          style={[
            styles.syncSurface,
            { backgroundColor: colors.elevation.level1, marginBottom: 24 },
          ]}
        >
          <View style={styles.row}>
            <Icon source="bluetooth-connect" size={32} />
            <View style={{ flex: 1 }}>
              <Text variant="titleLarge">{state.device?.name ?? 'Omi'}</Text>
              <Text variant="bodyMedium" style={styles.subtle}>
                {state.settings.mode === 'realtime'
                  ? 'Real-time sync enabled'
                  : 'Paired · connects when you sync'}
              </Text>
            </View>
          </View>
          <LiveMonitor disabled={state.busy} />
          <MicrophoneGain state={state} action={action} />
          <Divider style={{ marginVertical: 24 }} />
          {[
            ['Serial number', state.device?.serial ?? 'Read on next sync'],
            ['Firmware', state.device?.firmware ?? 'Read on next sync'],
            [
              'Battery',
              state.device?.battery === undefined
                ? 'Read on next sync'
                : `${state.device.battery}%`,
            ],
            ['Bluetooth address', state.settings.deviceAddress],
          ].map(([label, value]) => (
            <View
              key={label}
              style={[styles.rowBetween, { marginVertical: 9, flexWrap: 'wrap', gap: 8 }]}
            >
              <Text variant="bodyMedium" style={styles.subtle}>
                {label}
              </Text>
              <Text variant="bodyMedium" selectable>
                {value}
              </Text>
            </View>
          ))}
          <Button
            mode="outlined"
            disabled={state.busy}
            onPress={() => void action(() => client.unpair(), 'Device disconnected.')}
            style={{ alignSelf: 'flex-start', marginTop: 24 }}
          >
            Forget device
          </Button>
        </View>
      ) : (
        <View
          style={[
            styles.syncSurface,
            { backgroundColor: colors.elevation.level1, marginBottom: 24 },
          ]}
        >
          <Icon source="bluetooth" size={36} />
          <Text variant="titleLarge" style={{ marginTop: 16 }}>
            Connect your Omi to get started.
          </Text>
          <Text variant="bodyMedium" style={[styles.subtle, { marginTop: 8, marginBottom: 24 }]}>
            First, pair your Omi. Then import a recording to listen on this device. Turn on
            Bluetooth and keep your device nearby. Disconnect other Bluetooth clients before
            pairing.
          </Text>
          <Button
            mode="contained"
            icon="bluetooth-searching"
            loading={scanning}
            disabled={scanning || pairing || state.busy}
            contentStyle={{ minHeight: 48 }}
            style={{ alignSelf: 'flex-start' }}
            onPress={() => void scan()}
          >
            {scanning ? 'Looking for Omi…' : 'Find a device'}
          </Button>
        </View>
      )}
      {searched && !scanning && !devices.length && !state.settings.deviceAddress ? (
        <View style={{ marginTop: 24, gap: 8 }} accessibilityLiveRegion="polite">
          <Text variant="titleMedium">No Omi found</Text>
          <Text variant="bodyMedium" style={styles.subtle}>
            Keep your Omi nearby, check Bluetooth is on, then try Find a device again.
          </Text>
        </View>
      ) : null}
      {devices.map((d) => (
        <View
          key={d.address}
          style={[styles.rowBetween, { marginTop: 16, paddingVertical: 12, flexWrap: 'wrap' }]}
        >
          <View style={{ flex: 1 }}>
            <Text variant="titleMedium">{d.name}</Text>
            <Text variant="bodySmall">{d.address}</Text>
          </View>
          <Button
            mode="outlined"
            disabled={scanning || pairing || state.busy}
            onPress={() =>
              void action(async () => {
                setPairing(true)
                try {
                  await client.pair(d)
                  setDevices([])
                } finally {
                  setPairing(false)
                }
              }, 'Omi is paired. Your recordings are ready to sync.')
            }
          >
            Connect
          </Button>
        </View>
      ))}
      {!state.settings.deviceAddress ? (
        <DeviceSync state={state} action={action} onSettings={onSettings} />
      ) : null}
      <Text variant="titleMedium" style={{ marginTop: 36 }}>
        Made for local recording
      </Text>
      <Text variant="bodyMedium" style={[styles.subtle, { marginTop: 10, lineHeight: 24 }]}>
        Omi ring-storage firmware 3.0.20+ recording Opus is supported. Importing on stock firmware
        releases transferred storage on your Omi. {retentionSummary(state.settings)} You can change
        local retention in Settings or explicitly delete verified local copies in Library. Stock
        devices disconnect after each import to resume device recording; real-time mode polls at
        your configured interval.
      </Text>
      <Text variant="bodyMedium" style={[styles.subtle, { marginTop: 16, lineHeight: 24 }]}>
        In Manual mode, Uomi disconnects when it leaves the foreground. Your Omi continues recording
        to its own storage. Real-time mode keeps the connection active and sends newly committed
        recordings in the background.
      </Text>
    </View>
  )
}
function SettingsScreen({
  state,
  action,
  onDirtyChange,
}: {
  state: Snapshot
  action: Action
  onDirtyChange: (dirty: boolean) => void
}) {
  const { colors } = useTheme()
  const [form, setForm] = useState<Settings>(state.settings)
  const [token, setToken] = useState('')
  const [secret, setSecret] = useState('')
  const [minutes, setMinutes] = useState(String(form.segmentSeconds / 60))
  const [hours, setHours] = useState(String(form.intervalHours))
  const [saving, setSaving] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [saveError, setSaveError] = useState('')
  const [discard, setDiscard] = useState(false)
  const dirty =
    JSON.stringify(form) !== JSON.stringify(state.settings) ||
    !!token ||
    !!secret ||
    minutes !== String(state.settings.segmentSeconds / 60) ||
    hours !== String(state.settings.intervalHours)
  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])
  // Pairing can update settings while this retained form is hidden. Merge only untouched fields.
  const previousSettings = useRef(state.settings)
  useEffect(() => {
    const previous = previousSettings.current
    setForm((current) => {
      const merged = { ...current }
      for (const key of Object.keys(state.settings) as (keyof Settings)[]) {
        if (current[key] === previous[key]) Object.assign(merged, { [key]: state.settings[key] })
      }
      return merged
    })
    if (
      previous.segmentSeconds !== state.settings.segmentSeconds &&
      minutes === String(previous.segmentSeconds / 60)
    )
      setMinutes(String(state.settings.segmentSeconds / 60))
    if (
      previous.intervalHours !== state.settings.intervalHours &&
      hours === String(previous.intervalHours)
    )
      setHours(String(state.settings.intervalHours))
    previousSettings.current = state.settings
  }, [state.settings])
  const sourceError = form.notionSource?.trim()
    ? (() => {
        try {
          notionId(form.notionSource.trim())
          return ''
        } catch {
          return 'Paste the full Notion database URL or its 32-character ID.'
        }
      })()
    : ''
  const minutesError =
    !Number.isFinite(Number(minutes)) ||
    Math.round(Number(minutes) * 60) < 1 ||
    Number(minutes) > 15
      ? 'Enter a duration from 1 second (0.017 minutes) to 15 minutes.'
      : ''
  const hoursError =
    !Number.isFinite(Number(hours)) || Number(hours) < 0.25 || Number(hours) > 168
      ? 'Enter an interval from 0.25 to 168 hours.'
      : ''
  const save = async (check = false) => {
    if (saving || state.busy || state.checkingNotion) return
    setSaveError('')
    setFeedback('')
    if (sourceError || minutesError || hoursError) {
      setSaveError('Check the highlighted fields before saving.')
      return
    }
    if (check && (!form.notionSource?.trim() || !(token.trim() || state.hasSecret))) {
      setSaveError(
        'Enter a Notion database URL and connection token before checking the connection.',
      )
      return
    }
    setSaving(true)
    let saved = false
    try {
      await client.save(
        {
          ...form,
          endpoint: '',
          notionSource: form.notionSource?.trim(),
          transcriberEndpoint: form.transcriberEndpoint?.trim(),
          segmentSeconds: Math.round(Number(minutes) * 60),
          intervalHours: Number(hours),
        },
        token.trim() || undefined,
        secret || undefined,
      )
      saved = true
      setToken('')
      setSecret('')
      setForm(client.getSnapshot().settings)
      setMinutes(String(client.getSnapshot().settings.segmentSeconds / 60))
      setHours(String(client.getSnapshot().settings.intervalHours))
      if (check) {
        if (client.getSnapshot().busy || client.getSnapshot().checkingNotion)
          throw Error('Wait for the current sync to finish, then check the connection again.')
        await client.refreshNotion()
      }
      setFeedback(
        check
          ? 'Settings saved. Notion connection checked and recordings refreshed.'
          : 'Settings saved.',
      )
    } catch (error) {
      setSaveError(
        `${saved ? 'Settings saved, but Notion could not be checked.' : 'Settings could not be saved.'} ${error instanceof Error ? error.message : String(error)} ${check ? 'Check the database URL, token and connection permissions, then try again.' : 'Review your settings and try saving again. Your draft is kept.'}`,
      )
    } finally {
      setSaving(false)
    }
  }
  const reset = () => {
    setForm(state.settings)
    setToken('')
    setSecret('')
    setMinutes(String(state.settings.segmentSeconds / 60))
    setHours(String(state.settings.intervalHours))
    setFeedback('Changes discarded.')
    setSaveError('')
    setDiscard(false)
  }
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setForm((f) => ({ ...f, [key]: value }))
  return (
    <View>
      <View style={styles.heading}>
        <Text variant="headlineLarge">Your Notion. Your recordings.</Text>
        <Text variant="bodyLarge" style={styles.subtle}>
          A direct connection, with credentials kept on this device.
        </Text>
      </View>
      <View style={{ gap: 12, marginBottom: 24 }}>
        <Text accessibilityLiveRegion="polite" variant="bodyMedium">
          {dirty
            ? 'Unsaved changes · Your draft stays when you switch tabs. Save before closing the app.'
            : 'Settings are up to date.'}
        </Text>
        <View style={[styles.row, { flexWrap: 'wrap', gap: 8 }]}>
          <Button
            mode="contained"
            loading={saving}
            disabled={saving || state.busy || state.checkingNotion || !dirty}
            contentStyle={{ minHeight: 48 }}
            onPress={() => void save()}
          >
            Save settings
          </Button>
          {dirty ? (
            <Button
              disabled={saving}
              contentStyle={{ minHeight: 48 }}
              onPress={() => setDiscard(true)}
            >
              Discard changes
            </Button>
          ) : null}
        </View>
        {saveError ? (
          <Text accessibilityRole="alert" style={{ color: colors.error }}>
            {saveError}
          </Text>
        ) : null}
        {feedback ? <Text accessibilityLiveRegion="polite">{feedback}</Text> : null}
      </View>
      <Text variant="titleLarge">Connect Notion (optional)</Text>
      <Text variant="bodyMedium" style={{ marginTop: 12, lineHeight: 24 }}>
        1. Create an internal connection for Uomi. Enable Read, Insert and Update content.
        {'\n'}2. Open a dedicated recordings database in Notion and add your connection to it.
        {'\n'}3. Paste the database URL and connection token below.
      </Text>
      <Button
        icon="open-in-new"
        style={{ alignSelf: 'flex-start', marginTop: 8 }}
        contentStyle={{ minHeight: 48 }}
        onPress={() =>
          void action(() =>
            Linking.openURL('https://www.notion.com/help/create-integrations-with-the-notion-api'),
          )
        }
      >
        Open Notion setup guide
      </Button>
      <TextInput
        editable={!saving}
        mode="outlined"
        error={!!sourceError}
        placeholder="https://www.notion.so/your-database-ID"
        accessibilityLabel="Database or data source ID / URL"
        label="Database or data source ID / URL"
        autoCapitalize="none"
        autoCorrect={false}
        value={form.notionSource ?? ''}
        onChangeText={(v) => set('notionSource', v)}
        style={styles.input}
      />
      <HelperText type="error" visible={!!sourceError}>
        {sourceError}
      </HelperText>
      <TextInput
        editable={!saving}
        mode="outlined"
        accessibilityLabel={
          state.hasSecret ? 'Notion token (saved securely)' : 'Notion connection token'
        }
        label={state.hasSecret ? 'Notion token (saved securely)' : 'Notion connection token'}
        placeholder="Leave blank to keep the saved token"
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        value={token}
        onChangeText={setToken}
        style={styles.input}
      />
      <Text variant="bodySmall" style={{ marginTop: 10 }}>
        Stored in Android Keystore or the Linux keyring. Tokens are never sent to the transcriber
        webhook.
      </Text>
      <Button
        mode="outlined"
        icon="connection"
        loading={saving || state.checkingNotion}
        disabled={saving || state.busy || state.checkingNotion}
        contentStyle={{ minHeight: 48 }}
        style={{ alignSelf: 'flex-start', marginTop: 16 }}
        onPress={() => void save(true)}
      >
        Save & check Notion connection
      </Button>
      <Text variant="bodySmall" style={{ marginTop: 8 }}>
        Saves these settings, prepares Uomi properties in your database and refreshes recordings.
        Audio is not uploaded by this check.
      </Text>
      <Divider style={styles.sectionDivider} />
      <List.Accordion
        title="Transcriber webhook (optional)"
        expanded={advanced}
        onPress={() => setAdvanced((value) => !value)}
      >
        <Text variant="titleMedium">Automatic transcripts</Text>
        <Text variant="bodyMedium" style={{ marginTop: 12, lineHeight: 24 }}>
          Add your transcriber service to receive transcripts and coordinate uploads across clients.
          Without it, you can still save audio directly to Notion.
        </Text>
        <TextInput
          editable={!saving}
          mode="outlined"
          accessibilityLabel="Transcriber HTTPS URL"
          label="Transcriber HTTPS URL"
          placeholder="https://your-mac.example/webhook"
          autoCapitalize="none"
          autoCorrect={false}
          value={form.transcriberEndpoint ?? ''}
          onChangeText={(v) => set('transcriberEndpoint', v)}
          style={styles.input}
        />
        <TextInput
          editable={!saving}
          mode="outlined"
          accessibilityLabel="Transcriber webhook secret"
          label="Transcriber webhook secret"
          placeholder="Leave blank to keep the saved secret"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          value={secret}
          onChangeText={setSecret}
          style={styles.input}
        />
        <Divider style={styles.sectionDivider} />
      </List.Accordion>
      <Text variant="titleLarge">When to sync</Text>
      <SegmentedButtons
        style={{ marginTop: 16 }}
        value={form.mode}
        onValueChange={(v) => set('mode', v as Mode)}
        buttons={[
          { value: 'manual', label: 'Manual', disabled: saving },
          { value: 'realtime', label: 'Real-time', disabled: saving },
          { value: 'periodic', label: 'Periodic', disabled: saving },
        ]}
      />
      <Text variant="bodyMedium" style={{ marginTop: 12, lineHeight: 24 }}>
        {form.mode === 'manual'
          ? 'Sync from Devices. No continuous background activity.'
          : form.mode === 'realtime'
            ? 'Sync committed recordings at the chunk interval. Android shows an ongoing notification.'
            : 'An OS scheduled job syncs on Wi-Fi after the interval. Timing depends on power management.'}
      </Text>
      {form.mode === 'periodic' ? (
        <TextInput
          editable={!saving}
          mode="outlined"
          error={!!hoursError}
          accessibilityLabel="Sync interval (hours)"
          label="Sync interval (hours)"
          keyboardType="decimal-pad"
          value={hours}
          onChangeText={setHours}
          style={styles.input}
        />
      ) : null}
      {hoursError ? <HelperText type="error">{hoursError}</HelperText> : null}
      <View style={[styles.rowBetween, { marginTop: 20, marginBottom: 12, gap: 16 }]}>
        <View style={{ flex: 1 }}>
          <Text variant="titleMedium">Remove verified local audio</Text>
          <Text variant="bodySmall" style={styles.subtle}>
            {retentionSummary({ ...form, deleteAfterUpload: form.deleteAfterUpload !== false })}
          </Text>
        </View>
        <Switch
          disabled={saving}
          value={form.deleteAfterUpload !== false}
          onValueChange={(value) => set('deleteAfterUpload', value)}
          accessibilityLabel="Remove local audio after verified Notion save"
        />
      </View>
      <TextInput
        editable={!saving}
        mode="outlined"
        error={!!minutesError}
        accessibilityLabel="Maximum audio chunk (minutes)"
        label="Maximum audio chunk (minutes)"
        keyboardType="decimal-pad"
        value={minutes}
        onChangeText={setMinutes}
        style={{ marginTop: 24 }}
      />
      <HelperText type="error" visible={!!minutesError}>
        {minutesError}
      </HelperText>
      <Text variant="bodySmall" style={{ marginTop: 10 }}>
        Up to 15 minutes including silent gaps. Nearby recordings are combined only when they fit.
        Original Opus frames are preserved without re-encoding. The transcriber splits requests to
        at most 10 minutes.
      </Text>
      <Button
        mode="contained"
        icon="check"
        loading={saving}
        disabled={saving || state.busy || state.checkingNotion || !dirty}
        contentStyle={{ minHeight: 48 }}
        style={{ alignSelf: 'flex-start', marginTop: 28 }}
        onPress={() => void save()}
      >
        Save settings
      </Button>
      <Portal>
        <Dialog visible={discard} onDismiss={() => setDiscard(false)}>
          <Dialog.Title>Discard unsaved settings?</Dialog.Title>
          <Dialog.Content>
            <Text>
              Your saved settings will be kept. Unsaved tokens and other changes will be cleared.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDiscard(false)}>Keep editing</Button>
            <Button onPress={reset}>Discard changes</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  )
}
const styles = StyleSheet.create({
  shell: { flex: 1, flexDirection: 'row' },
  rail: {
    width: 136,
    paddingHorizontal: 12,
    paddingTop: 32,
    paddingBottom: 26,
    borderRightWidth: 1,
  },
  brand: { alignItems: 'center', gap: 8 },
  railFooter: { alignItems: 'center', gap: 10 },
  navItem: { alignItems: 'center', paddingVertical: 8, gap: 5 },
  topbar: {
    minHeight: 76,
    paddingVertical: 16,
    flexWrap: 'wrap',
    paddingHorizontal: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  content: { paddingTop: 24, paddingBottom: 44 },
  heading: { gap: 12, marginBottom: 32 },
  subtle: { opacity: 0.76 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  syncSurface: {
    borderRadius: 16,
    padding: 24,
  },
  notice: {
    padding: 20,
    marginTop: 20,
    borderRadius: 12,
    flexDirection: 'row',
    gap: 12,
  },
  empty: { paddingVertical: 56, alignItems: 'center' },
  emptyIcon: {
    width: 68,
    height: 68,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  audioIcon: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomNav: {
    flexDirection: 'row',
    paddingTop: 8,
    paddingBottom: 8,
    borderTopWidth: 1,
  },
  sectionDivider: { marginVertical: 32 },
  input: { marginTop: 12 },
})
