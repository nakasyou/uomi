import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api } from './api'
import {
  recordingStart,
  recordingTitle as title,
  recordingDate as date,
  japanTime,
} from './recording-time'
import { stageLabel, progressLines, type ProgressDetail } from './job-progress'
import { speakerLabel } from './speaker-label'
import { mergeRecording, mergeRecordingPage } from './recording-state'
import './style.css'

type TranscriptionMode = 'standard' | 'long' | 'detailed'
type Job = {
  id: string
  status: string
  stage: string
  progress: number
  detail?: ProgressDetail
  attempt: number
  error?: string
  updated_at: number
  available_at: number
}
type Segment = { start_ms: number; end_ms: number; text: string; speaker?: string | null }
type Recording = {
  revision?: number
  updated_at?: string
  id: string
  title: string
  recorded_at: number | null
  duration_ms: number | null
  finished_at?: number
  status: string
  starred: boolean
  has_audio: boolean
  backup_step: string
  backup_status?: string
  backup_saved?: boolean
  backup_configured?: boolean
  backup_revision?: number
  backup_error: string | null
  preview?: string
  text?: string
  url?: string
  long_status?: string
  long_text?: string
  long_error?: string
  long_transcription?: Job | null
  detailed_status?: string
  detailed_text?: string
  detailed_error?: string
  transcription?: Job | null
  detailed_transcription?: Job | null
  segments?: Segment[]
  detailed_segments?: Segment[]
}
type Device = { hash: string; name: string; revoked: number; created_at: number }
const paths: Record<string, string> = {
  menu: 'M3 6h18M3 12h18M3 18h18',
  search: 'm21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z',
  play: 'm8 4 12 8-12 8V4Z',
  pause: 'M8 5v14M16 5v14',
  back: 'm8 4-4 4 4 4M4 8h8a7 7 0 1 1-6 11',
  forward: 'm16 4 4 4-4 4M20 8h-8a7 7 0 1 0 6 11',
  refresh: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 3M18 18a8 8 0 0 1-13-3',
  download: 'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4',
  close: 'm6 6 12 12M6 18 18 6',
  device: 'M7 2h10v20H7zM10 18h4',
  sun: 'M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  edit: 'm4 16 12-12 4 4-12 12H4v-4Z',
  note: 'M6 3h12v18H6zM9 8h6M9 12h6M9 16h4',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
}
function Icon({ name, fill = false }: { name: string; fill?: boolean }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill={fill ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.note} />
    </svg>
  )
}
const clock = (s: number) =>
  Number.isFinite(s)
    ? `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`
    : '0:00'
const durationOf = (r: Recording) =>
  Math.max(0, (r.duration_ms ?? Math.max(0, (r.finished_at ?? 0) - (r.recorded_at ?? 0))) / 1000)
const active = (j: Job | undefined | null) =>
  !!j && !['completed', 'failed', 'Completed', 'Failed'].includes(j.status)
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
function JobState({
  job,
  fallback,
  error,
}: {
  job?: Job | null
  fallback: string
  error?: string
}) {
  if (!job)
    return (
      <div className="job-state">
        <span>{fallback}</span>
        {error && <p className="error">{error}</p>}
      </div>
    )
  return (
    <div className="job-state" role="status">
      <strong>{stageLabel(job.stage, job.status)}</strong>
      {active(job) && (
        <progress
          max="1"
          {...(job.progress > 0 ? { value: job.progress } : {})}
          aria-label="Recording processing progress"
        />
      )}
      {progressLines({
        ...job.detail,
        active: job.status === 'processing' ? job.detail?.active : [],
      }).map((line) => (
        <span key={line}>{line}</span>
      ))}
      <span>
        Attempt {job.attempt}
        {job.updated_at ? ` · Updated ${japanTime(job.updated_at)} JST` : ''}
      </span>
      {job.status === 'retry' && job.available_at > Date.now() && (
        <span>Retry at {japanTime(job.available_at)}</span>
      )}
      {job.error && <p className="error">{job.error}</p>}
    </div>
  )
}
function App() {
  const [items, setItems] = useState<Recording[]>([]),
    [selected, setSelected] = useState<Recording | null>(null),
    [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [onlyStar, setOnlyStar] = useState(false),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [drawer, setDrawer] = useState(false),
    [settings, setSettings] = useState(false),
    [light, setLight] = useState(false),
    [notice, updateNotice] = useState(''),
    [noticeTone, setNoticeTone] = useState<'error' | 'success'>('error'),
    [view, setView] = useState<TranscriptionMode>('standard'),
    [busy, setBusy] = useState(''),
    [playing, setPlaying] = useState(false),
    [position, setPosition] = useState(0),
    [duration, setDuration] = useState(0),
    [rate, setRate] = useState(1),
    [peaks, setPeaks] = useState<number[]>([]),
    [waveLoading, setWaveLoading] = useState(false),
    [audioError, setAudioError] = useState(''),
    [rename, setRename] = useState<string | null>(null)
  const audio = useRef<HTMLAudioElement>(null),
    dialog = useRef<HTMLDialogElement>(null),
    requestId = useRef(0),
    chooseId = useRef(0),
    selectedRef = useRef<Recording | null>(null),
    waveAbort = useRef<AbortController | null>(null)
  const [keys, setKeys] = useState<Device[]>([]),
    [deviceName, setDeviceName] = useState(''),
    [credentials, setCredentials] = useState<Record<string, string> | null>(null),
    [deviceError, setDeviceError] = useState(''),
    [migration, setMigration] = useState<{
      status: string
      error?: string
      watermark?: string
    } | null>(null),
    [syncing, setSyncing] = useState(false),
    [synced, setSynced] = useState(0)
  function setNotice(value: string, tone: 'error' | 'success' = 'error') {
    updateNotice(value)
    setNoticeTone(tone)
  }
  const stopSync = useRef(false)
  useEffect(() => {
    document.documentElement.dataset.theme = light ? 'light' : 'dark'
  }, [light])
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 350)
    return () => clearTimeout(t)
  }, [query])
  useEffect(() => {
    if (settings) dialog.current?.showModal()
    else dialog.current?.close()
  }, [settings])
  function merge(id: string, data: Partial<Recording>) {
    setSelected((r) => (r?.id === id ? mergeRecording(r, data) : r))
    if (selectedRef.current?.id === id)
      selectedRef.current = mergeRecording(selectedRef.current, data)
    setItems((rs) => rs.map((r) => (r.id === id ? mergeRecording(r, data) : r)))
  }
  async function load(next?: string) {
    const gen = ++requestId.current
    setLoading(true)
    setError('')
    try {
      if (search && [...search].length < 2) {
        setItems([])
        setCursor(null)
        return
      }
      const p = new URLSearchParams()
      if (search) p.set('q', search)
      if (from) p.set('from', new Date(from + 'T00:00:00+09:00').toISOString())
      if (to) {
        const end = new Date(to + 'T00:00:00+09:00')
        end.setTime(end.getTime() + 86400000)
        p.set('to', end.toISOString())
      }
      if (from && to && from > to) throw Error('The start date must be before the end date.')
      if (onlyStar) p.set('starred', '1')
      if (next) p.set('cursor', next)
      const data = await api('/api/recordings?' + p)
      if (gen !== requestId.current) return
      setItems((old) => mergeRecordingPage(old, data.results, !!next))
      setCursor(data.next_cursor)
      if (!next && !selectedRef.current && data.results[0]) void choose(data.results[0])
    } catch (e) {
      if (gen === requestId.current) setError(message(e))
    } finally {
      if (gen === requestId.current) setLoading(false)
    }
  }
  useEffect(() => {
    void load()
  }, [search, from, to, onlyStar])
  async function choose(r: Recording) {
    const gen = ++chooseId.current
    audio.current?.pause()
    waveAbort.current?.abort()
    selectedRef.current = r
    setSelected(r)
    setDrawer(false)
    setView('standard')
    setRename(null)
    setPosition(0)
    setDuration(durationOf(r))
    setPlaying(false)
    setPeaks([])
    setAudioError('')
    try {
      const full = await api('/api/recordings/' + r.id)
      if (gen === chooseId.current) merge(r.id, full)
    } catch (e) {
      if (gen === chooseId.current) setNotice(message(e))
    }
  }
  // Refresh server job state without remounting the audio element or interrupting playback.
  useEffect(() => {
    if (!selected) return
    const id = selected.id
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const controller = new AbortController()
    async function refresh() {
      try {
        const state = await api('/api/recordings/' + id + '/status', { signal: controller.signal })
        if (cancelled) return
        const previous = selectedRef.current
        const changed =
          previous?.id === id &&
          (state.revision !== previous.revision ||
            state.has_audio !== previous.has_audio ||
            state.updated_at !== previous.updated_at)
        merge(id, state)
        if (changed) {
          const full = await api('/api/recordings/' + id, { signal: controller.signal })
          if (cancelled) return
          merge(id, full)
        }
        timer = setTimeout(
          () => void refresh(),
          active(state.transcription) ||
            active(state.long_transcription) ||
            active(state.detailed_transcription)
            ? 3000
            : 15000,
        )
      } catch (e) {
        if (!cancelled) {
          setNotice(message(e))
          timer = setTimeout(() => void refresh(), 15000)
        }
      }
    }
    timer = setTimeout(() => void refresh(), 3000)
    return () => {
      cancelled = true
      controller.abort()
      clearTimeout(timer)
    }
  }, [selected?.id])
  async function action(key: string, run: () => Promise<void>) {
    if (busy) return
    setBusy(key)
    try {
      await run()
    } catch (e) {
      setNotice(message(e))
    } finally {
      setBusy('')
    }
  }
  async function patch(data: { title?: string; starred?: boolean }) {
    const r = selectedRef.current
    if (!r) return
    await action('patch', async () => {
      const result = await api('/api/recordings/' + r.id, {
        method: 'PATCH',
        body: JSON.stringify(data),
      })
      merge(r.id, {
        title: result.title ?? data.title ?? r.title,
        starred: result.starred ?? data.starred ?? r.starred,
        revision: result.revision ?? r.revision,
        updated_at: result.updated_at ?? r.updated_at,
      })
      if (selectedRef.current?.id === r.id) setRename(null)
    })
  }
  async function transcribe(mode: TranscriptionMode) {
    const r = selectedRef.current
    if (!r) return
    await action('transcribe', async () => {
      await api(
        `/api/recordings/${r.id}/${mode === 'standard' ? 'transcription' : `${mode}-transcription`}`,
        { method: 'POST', body: '{"retry":true}' },
      )
      const full = await api('/api/recordings/' + r.id)
      merge(r.id, full)
      if (selectedRef.current?.id === r.id) setView(mode)
    })
  }
  async function waveform() {
    const r = selectedRef.current
    if (!r?.has_audio || waveLoading) return
    const gen = chooseId.current
    const controller = new AbortController()
    waveAbort.current = controller
    setWaveLoading(true)
    let context: AudioContext | undefined
    try {
      const res = await fetch(`/api/recordings/${r.id}/audio`, { signal: controller.signal })
      if (!res.ok) throw Error(`Audio read failed: HTTP ${res.status}`)
      context = new AudioContext()
      const buffer = await context.decodeAudioData(await res.arrayBuffer()),
        data = buffer.getChannelData(0),
        count = 200,
        step = Math.ceil(data.length / count),
        values = []
      for (let i = 0; i < count; i++) {
        let max = 0
        for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j += 8)
          max = Math.max(max, Math.abs(data[j]))
        values.push(max)
      }
      if (gen === chooseId.current) setPeaks(values)
    } catch (e) {
      if (!controller.signal.aborted) setNotice('Waveform: ' + message(e))
    } finally {
      try {
        await context?.close()
      } catch (e) {
        setNotice('Audio decoder cleanup: ' + message(e))
      }
      setWaveLoading(false)
    }
  }
  function seek(value: number) {
    if (!audio.current || !selectedRef.current?.has_audio) return
    try {
      audio.current.currentTime = Math.max(0, Math.min(duration, value))
      setPosition(audio.current.currentTime)
    } catch (e) {
      setAudioError(message(e))
    }
  }
  async function play() {
    if (!audio.current) return
    try {
      setAudioError('')
      if (playing) audio.current.pause()
      else await audio.current.play()
    } catch (e) {
      setAudioError('Playback: ' + message(e))
    }
  }
  async function syncNotion() {
    if (syncing) return
    setSyncing(true)
    setSynced(0)
    stopSync.current = false
    try {
      let more = true,
        count = 0
      while (more && !stopSync.current) {
        const result = await api('/api/migrations/notion', { method: 'POST', body: '{}' })
        count += result.processed
        setSynced(count)
        more = result.has_more
      }
      setMigration(await api('/api/migrations/notion'))
      setNotice(
        stopSync.current ? 'Import paused. Progress saved.' : 'Notion import complete.',
        'success',
      )
      await load()
    } catch (e) {
      setMigration({ status: 'failed', error: message(e) })
      setNotice('Notion import: ' + message(e))
    } finally {
      setSyncing(false)
    }
  }
  async function openSettings() {
    setSettings(true)
    setDeviceError('')
    const results = await Promise.allSettled([api('/api/clients'), api('/api/migrations/notion')])
    const [devicesResult, migrationResult] = results
    if (devicesResult.status === 'fulfilled') setKeys(devicesResult.value.results)
    else setDeviceError(message(devicesResult.reason))
    if (migrationResult.status === 'fulfilled') setMigration(migrationResult.value)
    else setMigration({ status: 'failed', error: message(migrationResult.reason) })
  }
  async function createKey() {
    await action('create', async () => {
      const c = await api('/api/clients', {
        method: 'POST',
        body: JSON.stringify({ name: deviceName }),
      })
      setCredentials(c)
      setDeviceName('')
      try {
        setKeys((await api('/api/clients')).results)
      } catch (e) {
        setDeviceError(message(e))
      }
    })
  }
  const currentJob =
    view === 'standard'
      ? selected?.transcription
      : view === 'long'
        ? selected?.long_transcription
        : selected?.detailed_transcription
  const transcript =
    view === 'standard'
      ? selected?.text
      : view === 'long'
        ? selected?.long_text
        : selected?.detailed_text
  const segments =
    view === 'standard' ? selected?.segments : view === 'long' ? [] : selected?.detailed_segments
  return (
    <div className="app">
      <header className="topbar">
        <button
          className="icon-button menu-button"
          aria-label="Show recordings"
          aria-expanded={drawer}
          onClick={() => setDrawer(!drawer)}
        >
          <Icon name="menu" />
        </button>
        <a className="brand" href="/">
          Uomi<span>Recorder</span>
        </a>
        <div className="search">
          <Icon name="search" />
          <input
            aria-label="Search recordings"
            placeholder="Search recordings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="icon-button" aria-label="Clear search" onClick={() => setQuery('')}>
              <Icon name="close" />
            </button>
          )}
        </div>
        <button
          className="icon-button theme"
          aria-label={light ? 'Use dark theme' : 'Use light theme'}
          onClick={() => setLight(!light)}
        >
          <Icon name="sun" />
        </button>
        <button
          className="icon-button"
          aria-label="Devices and backup"
          onClick={() => void openSettings()}
        >
          <Icon name="settings" />
        </button>
      </header>
      {notice && (
        <div className={`notice ${noticeTone}`} role={noticeTone === 'error' ? 'alert' : 'status'}>
          <span>{notice}</span>
          <button
            aria-label="Dismiss message"
            className="icon-button"
            onClick={() => setNotice('')}
          >
            <Icon name="close" />
          </button>
        </div>
      )}
      <div className="workspace">
        <aside className={`sidebar ${drawer ? 'open' : ''}`} aria-label="Recordings">
          <div className="list-heading">
            <h1>Recordings</h1>
            <button
              className="icon-button"
              aria-label="Refresh recordings"
              disabled={loading}
              onClick={() => void load()}
            >
              <Icon name="refresh" />
            </button>
          </div>
          <div className="filters">
            <button
              className={`chip ${onlyStar ? 'active' : ''}`}
              aria-pressed={onlyStar}
              onClick={() => setOnlyStar(!onlyStar)}
            >
              <Icon name="star" />
              Starred
            </button>
            <details>
              <summary>Date range</summary>
              <div className="date-fields">
                <label>
                  From
                  <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </label>
                <label>
                  Through
                  <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                </label>
                {(from || to) && (
                  <button
                    onClick={() => {
                      setFrom('')
                      setTo('')
                    }}
                  >
                    Clear dates
                  </button>
                )}
              </div>
            </details>
          </div>
          {error && (
            <div className="list-message error" role="alert">
              {error}
              <button onClick={() => void load()}>Retry</button>
            </div>
          )}
          {search && [...search].length < 2 ? (
            <p className="list-message">Enter at least 2 characters.</p>
          ) : !items.length && !loading ? (
            <div className="list-message">
              <h2>
                {search || from || to || onlyStar ? 'No matching recordings' : 'No recordings yet'}
              </h2>
              {!search && !from && !to && !onlyStar && (
                <button onClick={() => void openSettings()}>Connect a device</button>
              )}
            </div>
          ) : (
            items.map((r, i) => (
              <React.Fragment key={r.id}>
                {(i === 0 || date(items[i - 1].recorded_at) !== date(r.recorded_at)) && (
                  <h2 className="group-date">{date(r.recorded_at)}</h2>
                )}
                <button
                  className={`recording ${selected?.id === r.id ? 'selected' : ''}`}
                  aria-current={selected?.id === r.id ? 'true' : undefined}
                  onClick={() => void choose(r)}
                >
                  <span className="recording-title">
                    {recordingStart(r.recorded_at)}
                    {!!r.starred && <Icon name="star" />}
                  </span>
                  <span className="recording-meta">
                    <span>{clock(durationOf(r))}</span>
                    <span>
                      {r.transcription
                        ? stageLabel(r.transcription.stage, r.transcription.status)
                        : r.status}
                    </span>
                  </span>
                  {r.preview && <span className="recording-preview">{r.preview}</span>}
                </button>
              </React.Fragment>
            ))
          )}
          {loading && (
            <p className="list-message" role="status">
              Loading recordings…
            </p>
          )}
          {cursor && (
            <button className="load-more" disabled={loading} onClick={() => void load(cursor)}>
              Load more
            </button>
          )}
        </aside>
        <main>
          {selected ? (
            <>
              <section className="recording-detail">
                <div className="detail-heading">
                  <div className="heading-text">
                    {rename !== null ? (
                      <form
                        className="rename-form"
                        onSubmit={(e) => {
                          e.preventDefault()
                          void patch({ title: rename })
                        }}
                      >
                        <input
                          autoFocus
                          aria-label="Recording title"
                          maxLength={200}
                          value={rename}
                          onChange={(e) => setRename(e.target.value)}
                        />
                        <button className="tonal" disabled={!!busy}>
                          Save
                        </button>
                        <button type="button" onClick={() => setRename(null)}>
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <h1>{title(selected)}</h1>
                    )}
                    <p>
                      {date(selected.recorded_at)} · {clock(durationOf(selected))}
                    </p>
                  </div>
                  <div className="detail-actions">
                    <button
                      className={`icon-button ${selected.starred ? 'starred' : ''}`}
                      disabled={!!busy}
                      aria-label={selected.starred ? 'Remove star' : 'Star recording'}
                      aria-pressed={selected.starred}
                      onClick={() => void patch({ starred: !selected.starred })}
                    >
                      <Icon name="star" fill={selected.starred} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Rename recording"
                      onClick={() => setRename(selected.title ?? '')}
                    >
                      <Icon name="edit" />
                    </button>
                    {selected.has_audio && (
                      <a
                        className="icon-button"
                        href={`/api/recordings/${selected.id}/audio`}
                        download={`${title(selected)}.ogg`}
                        aria-label="Download audio"
                      >
                        <Icon name="download" />
                      </a>
                    )}
                  </div>
                </div>
                <div className="detail-columns">
                  <div className="wave-panel">
                    {peaks.length ? (
                      <div
                        className="wave"
                        role="img"
                        aria-label="Audio waveform; use the playback slider to seek"
                        onClick={(e) =>
                          seek(
                            ((e.clientX - e.currentTarget.getBoundingClientRect().left) /
                              e.currentTarget.clientWidth) *
                              duration,
                          )
                        }
                      >
                        {peaks.map((p, i) => (
                          <i
                            key={i}
                            className={
                              duration && i / peaks.length <= position / duration ? 'played' : ''
                            }
                            style={{ height: `${Math.max(2, p * 82)}%` }}
                          />
                        ))}
                        <span
                          className="playhead"
                          style={{ left: `${duration ? (position / duration) * 100 : 0}%` }}
                        />
                      </div>
                    ) : (
                      <div className="wave-empty">
                        <Icon name="note" />
                        {selected.has_audio ? (
                          <button
                            className="tonal"
                            disabled={waveLoading}
                            onClick={() => void waveform()}
                          >
                            {waveLoading ? 'Reading audio…' : 'Show waveform'}
                          </button>
                        ) : (
                          <>
                            <p>Audio not imported</p>
                            {selected.url && (
                              <a href={selected.url} target="_blank" rel="noreferrer">
                                Open Notion backup
                              </a>
                            )}
                            <button
                              className="tonal"
                              disabled={!!busy}
                              onClick={() => {
                                const id = selected.id
                                void action('import-audio', async () => {
                                  const result = await api(`/api/recordings/${id}/resync`, {
                                    method: 'POST',
                                    body: '{}',
                                  })
                                  merge(id, await api(`/api/recordings/${id}`))
                                  if (result.warning)
                                    setNotice(
                                      `Notion import: ${result.warning}${result.missing_source_files?.length ? ` (${result.missing_source_files.join(', ')})` : ''}`,
                                    )
                                  else setNotice('Audio imported.', 'success')
                                })
                              }}
                            >
                              {busy === 'import-audio' ? 'Importing…' : 'Import audio'}
                            </button>
                          </>
                        )}
                      </div>
                    )}
                    <details className="backup-status">
                      <summary>
                        Notion backup ·{' '}
                        {{
                          disabled: 'Off',
                          missing_audio: 'Original audio unavailable',
                          saved: 'Saved',
                          uncertain: 'Needs review',
                          processing: 'Saving…',
                          retry: 'Needs attention',
                          pending: 'Pending',
                        }[selected.backup_status ?? 'pending'] ?? 'Pending'}
                      </summary>
                      {selected.backup_error && <p className="error">{selected.backup_error}</p>}
                      <button
                        disabled={
                          !!busy ||
                          ['disabled', 'missing_audio', 'saved', 'processing'].includes(
                            selected.backup_status ?? '',
                          )
                        }
                        onClick={() =>
                          void action('backup', async () => {
                            await api(`/api/recordings/${selected.id}/backup`, {
                              method: 'POST',
                              body: '{}',
                            })
                            merge(selected.id, await api('/api/recordings/' + selected.id))
                            setNotice('Backup requested.', 'success')
                          })
                        }
                      >
                        {busy === 'backup' ? 'Requesting…' : 'Retry backup'}
                      </button>
                      {selected.url && (
                        <a href={selected.url} target="_blank" rel="noreferrer">
                          Open in Notion
                        </a>
                      )}
                    </details>
                  </div>
                  <article className="transcript" aria-label="Transcript">
                    <div
                      className="transcript-versions"
                      role="group"
                      aria-label="Transcript version"
                    >
                      <button
                        aria-pressed={view === 'standard'}
                        onClick={() => setView('standard')}
                      >
                        Transcript
                      </button>
                      <button aria-pressed={view === 'long'} onClick={() => setView('long')}>
                        Long · Chrome
                      </button>
                      <button
                        aria-pressed={view === 'detailed'}
                        onClick={() => setView('detailed')}
                      >
                        Detailed · Codex
                      </button>
                    </div>
                    {view === 'long' && (
                      <p className="muted">Long passages with short pauses retained. Text only.</p>
                    )}
                    <div className="transcription-controls">
                      <JobState
                        job={currentJob}
                        error={view === 'standard' ? undefined : selected[`${view}_error`]}
                        fallback={
                          view === 'standard'
                            ? selected.status
                            : (selected[`${view}_status`] ?? 'Not requested')
                        }
                      />
                      {!active(currentJob) && (
                        <button
                          className="tonal"
                          disabled={!!busy || !selected.has_audio}
                          onClick={() => void transcribe(view)}
                        >
                          {busy === 'transcribe'
                            ? 'Requesting…'
                            : currentJob?.status === 'failed' || currentJob?.status === 'Failed'
                              ? 'Retry transcription'
                              : transcript || currentJob?.status === 'completed'
                                ? 'Transcribe again'
                                : 'Transcribe'}
                        </button>
                      )}
                    </div>
                    {segments?.length ? (
                      <div className="transcript-text segments">
                        {segments.map((s, i) => (
                          <div className="segment" key={i}>
                            <button
                              onClick={() => seek(s.start_ms / 1000)}
                              aria-label={`Play from ${clock(s.start_ms / 1000)}`}
                            >
                              {clock(s.start_ms / 1000)}
                            </button>
                            <p>
                              {s.speaker !== undefined && (
                                <strong>{speakerLabel(s.speaker)} </strong>
                              )}
                              {s.text}
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : transcript ? (
                      <div className="transcript-text">
                        {transcript.split(/\n\n+/).map((p, i) => (
                          <p key={i}>{p}</p>
                        ))}
                      </div>
                    ) : (
                      <div className="transcript-empty">
                        <h2>
                          {active(currentJob)
                            ? 'Transcription in progress'
                            : currentJob?.status === 'completed'
                              ? currentJob.stage === 'completed_no_speech'
                                ? 'No speech detected'
                                : currentJob.stage === 'completed_empty'
                                  ? 'Speech detected, but no transcript returned'
                                  : 'No transcript returned'
                              : 'No transcript available'}
                        </h2>
                        {!selected.has_audio && (
                          <p>Import the audio to transcribe this recording.</p>
                        )}
                      </div>
                    )}
                  </article>
                </div>
              </section>
              <footer className="player">
                <audio
                  key={selected.id}
                  ref={audio}
                  src={selected.has_audio ? `/api/recordings/${selected.id}/audio` : undefined}
                  preload="metadata"
                  onTimeUpdate={() => setPosition(audio.current?.currentTime ?? 0)}
                  onLoadedMetadata={() => {
                    if (audio.current) {
                      audio.current.playbackRate = rate
                      setDuration(
                        Number.isFinite(audio.current.duration)
                          ? audio.current.duration
                          : durationOf(selected),
                      )
                    }
                  }}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onEnded={() => setPlaying(false)}
                  onError={() =>
                    setAudioError(
                      `Audio load failed (media error ${audio.current?.error?.code ?? 'unknown'}): ${audio.current?.error?.message ?? 'Check connection and retry.'}`,
                    )
                  }
                />
                <input
                  className="timeline"
                  aria-label="Playback position"
                  type="range"
                  min="0"
                  max={duration || 1}
                  step="0.1"
                  value={Math.min(position, duration || 1)}
                  disabled={!selected.has_audio}
                  onChange={(e) => seek(Number(e.target.value))}
                />
                <div className="time-labels">
                  <span>{clock(position)}</span>
                  <span>{clock(duration)}</span>
                </div>
                <div className="transport">
                  <span className="audio-kind">
                    {selected.has_audio ? 'Audio saved' : 'Audio unavailable'}
                  </span>
                  <div className="transport-buttons">
                    <button
                      className="skip"
                      aria-label="Back 10 seconds"
                      disabled={!selected.has_audio}
                      onClick={() => seek(position - 10)}
                    >
                      <Icon name="back" />
                      <span>10</span>
                    </button>
                    <button
                      className="play"
                      aria-label={playing ? 'Pause' : 'Play'}
                      disabled={!selected.has_audio}
                      onClick={() => void play()}
                    >
                      <Icon name={playing ? 'pause' : 'play'} fill={!playing} />
                    </button>
                    <button
                      className="skip"
                      aria-label="Forward 10 seconds"
                      disabled={!selected.has_audio}
                      onClick={() => seek(position + 10)}
                    >
                      <Icon name="forward" />
                      <span>10</span>
                    </button>
                    <label className="speed">
                      <span className="sr-only">Playback speed</span>
                      <select
                        value={rate}
                        onChange={(e) => {
                          const value = Number(e.target.value)
                          setRate(value)
                          if (audio.current) audio.current.playbackRate = value
                        }}
                      >
                        {[0.5, 0.75, 1, 1.25, 1.5, 2].map((v) => (
                          <option key={v} value={v}>
                            {v}×
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <span className="private-label">Private recordings</span>
                </div>
                {audioError && (
                  <div className="audio-error error" role="alert">
                    <span>{audioError}</span>
                    <button
                      onClick={() => {
                        setAudioError('')
                        audio.current?.load()
                      }}
                    >
                      Retry audio
                    </button>
                  </div>
                )}
              </footer>
            </>
          ) : (
            <div className="welcome">
              <Icon name="note" />
              <h1>{loading ? 'Loading recordings…' : 'Select a recording'}</h1>
              <button className="tonal mobile-only" onClick={() => setDrawer(true)}>
                Browse recordings
              </button>
            </div>
          )}
        </main>
      </div>
      <dialog
        ref={dialog}
        className="devices-dialog"
        onCancel={() => {
          setSettings(false)
          setCredentials(null)
        }}
        onClose={() => {
          setSettings(false)
          setCredentials(null)
        }}
      >
        <div className="dialog-heading">
          <h2>Devices and backup</h2>
          <button
            className="icon-button"
            aria-label="Close settings"
            onClick={() => {
              setSettings(false)
              setCredentials(null)
            }}
          >
            <Icon name="close" />
          </button>
        </div>
        {deviceError && (
          <p className="error" role="alert">
            {deviceError}
          </p>
        )}
        <h3>Device access</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void createKey()
          }}
        >
          <label>
            Device name
            <input
              required
              maxLength={100}
              placeholder="My phone"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
            />
          </label>
          <button className="tonal" disabled={!!busy}>
            {busy === 'create' ? 'Creating…' : 'Create key'}
          </button>
        </form>
        {credentials && (
          <div className="credentials">
            <p>Copy this key now. It is shown once.</p>
            {[
              ['API URL', credentials.upload_url],
              ['API key', credentials.secret],
              ['Sites access token', credentials.access_token],
            ]
              .filter(([, v]) => v)
              .map(([label, value]) => (
                <label key={label}>
                  {label}
                  <input readOnly value={value} onFocus={(e) => e.target.select()} />
                </label>
              ))}
          </div>
        )}
        <div className="device-list">
          {keys.map((k) => (
            <div key={k.hash}>
              <span>
                {k.name}
                <small>{k.revoked ? 'Revoked' : new Date(k.created_at).toLocaleDateString()}</small>
              </span>
              <button
                disabled={!!k.revoked || !!busy}
                onClick={() =>
                  void action('revoke', async () => {
                    await api('/api/clients/' + k.hash, { method: 'DELETE' })
                    setKeys((old) => old.map((v) => (v.hash === k.hash ? { ...v, revoked: 1 } : v)))
                  })
                }
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
        <h3>Notion migration</h3>
        <p>Import earlier recordings. Existing server recordings are preserved.</p>
        {migration && (
          <p role="status">
            {migration.status === 'completed'
              ? 'Import complete'
              : migration.status === 'running'
                ? 'Import in progress'
                : migration.status === 'paused'
                  ? 'Import paused'
                  : migration.status === 'failed'
                    ? 'Import needs attention'
                    : 'Not imported yet'}
          </p>
        )}
        {migration?.error && <p className="error">{migration.error}</p>}
        <button className="tonal" disabled={syncing} onClick={() => void syncNotion()}>
          {syncing
            ? `Importing · ${synced}`
            : migration?.status === 'paused' || migration?.status === 'failed'
              ? 'Resume import'
              : 'Import from Notion'}
        </button>
        {syncing && (
          <button
            onClick={() => {
              stopSync.current = true
            }}
          >
            Pause import
          </button>
        )}
      </dialog>
      {syncing && !settings && (
        <div className="sync-progress" role="status">
          Importing · {synced}
          <button
            onClick={() => {
              stopSync.current = true
            }}
          >
            Pause
          </button>
        </div>
      )}
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
