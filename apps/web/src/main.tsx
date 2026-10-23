import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'
type Recording = {
  id: string
  title: string
  recorded_at: number | null
  duration_ms: number | null
  finished_at?: number
  status: string
  starred: boolean
  has_audio: boolean
  backup_step: string
  backup_error: string | null
  preview?: string
  text?: string
  url?: string
}
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
async function api(path: string, options: RequestInit = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  })
  const value = await res.json()
  if (!res.ok) throw Error(value.error ?? `HTTP ${res.status}`)
  return value
}
const clock = (seconds: number) =>
  Number.isFinite(seconds)
    ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
    : '0:00'
const date = (v: number | null) =>
  v
    ? new Date(v).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : 'Device clock unavailable'
const title = (r: Recording) =>
  r.title ||
  (r.recorded_at
    ? new Date(r.recorded_at).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'Untimed recording')
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
    [devices, setDevices] = useState(false),
    [light, setLight] = useState(false),
    [notice, setNotice] = useState('')
  const audio = useRef<HTMLAudioElement>(null),
    [playing, setPlaying] = useState(false),
    [position, setPosition] = useState(0),
    [duration, setDuration] = useState(0),
    [rate, setRate] = useState(1),
    [peaks, setPeaks] = useState<number[]>([]),
    [waveLoading, setWaveLoading] = useState(false),
    [audioError, setAudioError] = useState('')
  const requestId = useRef(0),
    chooseId = useRef(0),
    selectedRef = useRef<Recording | null>(null)
  useEffect(() => {
    document.documentElement.dataset.theme = light ? 'light' : 'dark'
  }, [light])
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 350)
    return () => clearTimeout(t)
  }, [query])
  function params(next?: string) {
    const p = new URLSearchParams()
    if (search) p.set('q', search)
    if (from) p.set('from', new Date(from + 'T00:00:00').toISOString())
    if (to) {
      const d = new Date(to + 'T00:00:00')
      d.setDate(d.getDate() + 1)
      p.set('to', d.toISOString())
    }
    if (onlyStar) p.set('starred', '1')
    if (next) p.set('cursor', next)
    return p
  }
  async function load(next?: string) {
    const gen = ++requestId.current
    setLoading(true)
    setError('')
    try {
      if (search && [...search].length < 3) {
        setItems([])
        setCursor(null)
        return
      }
      const data = await api('/api/recordings?' + params(next))
      if (gen !== requestId.current) return
      setItems((old) => (next ? [...old, ...data.results] : data.results))
      setCursor(data.next_cursor)
      if (!next && !selectedRef.current && data.results[0]) void choose(data.results[0])
    } catch (e) {
      if (gen === requestId.current) setError((e as Error).message)
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
    selectedRef.current = r
    setSelected(r)
    setDrawer(false)
    setPosition(0)
    setDuration((r.duration_ms ?? (r.finished_at ?? 0) - (r.recorded_at ?? 0)) / 1000)
    setPlaying(false)
    setPeaks([])
    setAudioError('')
    try {
      const full = await api('/api/recordings/' + r.id)
      if (gen === chooseId.current) {
        setSelected(full)
        selectedRef.current = full
      }
    } catch (e) {
      setError((e as Error).message)
    }
  }
  async function patch(data: any) {
    if (!selected) return
    try {
      await api('/api/recordings/' + selected.id, { method: 'PATCH', body: JSON.stringify(data) })
      setSelected({ ...selected, ...data })
      setItems(items.map((r) => (r.id === selected.id ? { ...r, ...data } : r)))
    } catch (e) {
      setNotice((e as Error).message)
    }
  }
  async function waveform() {
    if (!selected?.has_audio || waveLoading) return
    const id = selected.id,
      gen = chooseId.current
    setWaveLoading(true)
    let context: AudioContext | undefined
    try {
      const res = await fetch(`/api/recordings/${id}/audio`)
      if (!res.ok) throw Error()
      context = new AudioContext()
      const buffer = await context.decodeAudioData(await res.arrayBuffer()),
        data = buffer.getChannelData(0),
        count = 200,
        step = Math.ceil(data.length / count),
        p = []
      for (let i = 0; i < count; i++) {
        let max = 0
        for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j += 8)
          max = Math.max(max, Math.abs(data[j]))
        p.push(max)
      }
      if (gen === chooseId.current) setPeaks(p)
    } catch {
      setNotice('Waveform unavailable in this browser. Audio playback may still work.')
    } finally {
      await context?.close()
      setWaveLoading(false)
    }
  }
  const seek = (value: number) => {
    if (audio.current && selected?.has_audio) {
      audio.current.currentTime = Math.max(0, Math.min(duration, value))
      setPosition(audio.current.currentTime)
    }
  }
  const play = async () => {
    if (!audio.current) return
    try {
      if (playing) audio.current.pause()
      else await audio.current.play()
    } catch {
      setAudioError('Unable to play. Try downloading the original audio.')
    }
  }
  const [syncing, setSyncing] = useState(false),
    [synced, setSynced] = useState(0)
  const stopSync = useRef(false)
  async function syncNotion(reset = false) {
    setSyncing(true)
    setSynced(0)
    stopSync.current = false
    try {
      let first = true,
        more = true,
        count = 0
      while (more && !stopSync.current) {
        const result = await api('/api/resync', {
          method: 'POST',
          body: JSON.stringify({ reset: reset && first }),
        })
        first = false
        count += result.processed
        setSynced(count)
        more = result.has_more
      }
      setNotice(
        stopSync.current
          ? 'Notion resync paused; progress is saved.'
          : 'Notion cache is up to date.',
      )
      await load()
      if (selected) await choose(selected)
    } catch (e) {
      setNotice((e as Error).message)
    } finally {
      setSyncing(false)
    }
  }
  const [keys, setKeys] = useState<any[]>([]),
    [deviceName, setDeviceName] = useState(''),
    [credentials, setCredentials] = useState<any>(null)
  async function openDevices() {
    setDevices(true)
    try {
      setKeys((await api('/api/clients')).results)
    } catch (e) {
      setNotice((e as Error).message)
    }
  }
  return (
    <div className="app">
      <header className="topbar">
        <button
          className="icon-button"
          aria-label="Toggle recordings"
          onClick={() => setDrawer(!drawer)}
        >
          <Icon name="menu" />
        </button>
        <a className="brand" href="/">
          <svg viewBox="0 0 36 36" width="36" height="36" aria-hidden="true">
            <circle cx="18" cy="18" r="18" fill="#fff" />
            <path
              d="M9 16v4m4-9v14m5-18v22m5-17v12m4-9v6"
              stroke="#ed6868"
              strokeWidth="3"
              strokeLinecap="round"
            />
          </svg>
          <span>Uomi Recorder</span>
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
          className="icon-button"
          aria-label="Sync from Notion"
          disabled={syncing}
          onClick={() => void syncNotion()}
        >
          <Icon name="refresh" />
        </button>
        <button
          className="icon-button theme"
          aria-label="Toggle light theme"
          onClick={() => setLight(!light)}
        >
          <Icon name="sun" />
        </button>
        <button
          className="icon-button"
          aria-label="Connect devices"
          onClick={() => void openDevices()}
        >
          <Icon name="device" />
        </button>
      </header>
      <div className="workspace">
        <aside className={`sidebar ${drawer ? 'open' : ''}`} aria-label="Recordings">
          <div className="filters">
            <button
              className={`chip ${onlyStar ? 'active' : ''}`}
              aria-pressed={onlyStar}
              onClick={() => setOnlyStar(!onlyStar)}
            >
              <Icon name="star" />
              Starred
            </button>
            <button
              className="icon-button"
              aria-label="Refresh recordings"
              onClick={() => void load()}
            >
              <Icon name="refresh" />
            </button>
            <label>
              From
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label>
              Through
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
          {error && (
            <div className="list-message error" role="alert">
              {error}
              <button onClick={() => void load()}>Try again</button>
            </div>
          )}
          {search && [...search].length < 3 ? (
            <p className="list-message">Enter at least 3 characters to search.</p>
          ) : items.length === 0 && !loading ? (
            <div className="list-message">
              <h2>{search ? 'No matching recordings' : 'Your recordings will appear here'}</h2>
              <p>
                {search
                  ? 'Try another phrase or date range.'
                  : 'Connect your Omi client and sync your first recording.'}
              </p>
              <button onClick={() => void openDevices()}>Connect a device</button>
            </div>
          ) : (
            items.map((r, i) => (
              <React.Fragment key={r.id}>
                {(i === 0 || date(items[i - 1].recorded_at) !== date(r.recorded_at)) && (
                  <h2 className="group-date">{date(r.recorded_at)}</h2>
                )}
                <button
                  className={`recording ${selected?.id === r.id ? 'selected' : ''}`}
                  onClick={() => void choose(r)}
                >
                  <span className="recording-title">
                    {title(r)}
                    {r.starred && <Icon name="star" />}
                  </span>
                  <span className="recording-meta">
                    <span>
                      {r.recorded_at
                        ? new Date(r.recorded_at).toLocaleTimeString(undefined, {
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : 'Unknown time'}
                    </span>
                    <span>
                      {clock((r.duration_ms ?? (r.finished_at ?? 0) - (r.recorded_at ?? 0)) / 1000)}
                    </span>
                  </span>
                  <span className="status-line">
                    <i className={r.status === 'Completed' ? 'complete' : ''} />
                  </span>
                  <span className="sr-only">{r.status}</span>
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
                  <div>
                    <h1>{title(selected)}</h1>
                    <p>
                      {date(selected.recorded_at)} · {selected.status}
                    </p>
                  </div>
                  <div className="detail-actions">
                    <button
                      className={`icon-button ${selected.starred ? 'starred' : ''}`}
                      aria-label={selected.starred ? 'Remove star' : 'Star recording'}
                      aria-pressed={selected.starred}
                      onClick={() => void patch({ starred: !selected.starred })}
                    >
                      <Icon name="star" fill={selected.starred} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Rename recording"
                      onClick={() => {
                        const name = prompt('Recording title', selected.title ?? '')
                        if (name !== null) void patch({ title: name })
                      }}
                    >
                      <Icon name="edit" />
                    </button>
                    {selected.has_audio && (
                      <a
                        className="icon-button"
                        href={`/api/recordings/${selected.id}/audio`}
                        download={`${title(selected)}.ogg`}
                        aria-label="Download original audio"
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
                        aria-label="Audio amplitude waveform"
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
                            className={i / peaks.length <= position / duration ? 'played' : ''}
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
                        <p>
                          {selected.has_audio
                            ? 'Original audio, preserved.'
                            : 'Audio is stored in Notion for this earlier recording.'}
                        </p>
                        {selected.has_audio ? (
                          <button
                            className="tonal"
                            disabled={waveLoading}
                            onClick={() => void waveform()}
                          >
                            {waveLoading ? 'Reading audio…' : 'Show waveform'}
                          </button>
                        ) : (
                          selected.url && (
                            <a
                              className="tonal"
                              href={selected.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open in Notion
                            </a>
                          )
                        )}
                      </div>
                    )}
                    <div className="backup-status">
                      <button
                        onClick={() =>
                          void api(`/api/recordings/${selected.id}/resync`, {
                            method: 'POST',
                            body: '{}',
                          })
                            .then(() => choose(selected))
                            .catch((e) => setNotice(e.message))
                        }
                      >
                        Reload from Notion
                      </button>
                      <span>
                        {selected.backup_step === 'done'
                          ? 'Saved in Notion'
                          : selected.backup_step === 'legacy'
                            ? 'Imported from Notion'
                            : `Notion save: ${selected.backup_step}`}
                      </span>
                      {!['done', 'legacy'].includes(selected.backup_step) && (
                        <button
                          onClick={() =>
                            void api(`/api/recordings/${selected.id}/backup`, {
                              method: 'POST',
                              body: '{}',
                            })
                              .then(() =>
                                setNotice('Notion save scheduled. Refresh to check progress.'),
                              )
                              .catch((e) => setNotice(e.message))
                          }
                        >
                          Retry Notion save
                        </button>
                      )}
                      {selected.backup_error && <p className="error">{selected.backup_error}</p>}
                    </div>
                  </div>
                  <article className="transcript" aria-label="Transcript">
                    <div className="transcript-time">
                      {selected.recorded_at
                        ? new Date(selected.recorded_at).toLocaleTimeString(undefined, {
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : 'Recording'}
                      <span>Full recording</span>
                    </div>
                    {selected.text ? (
                      <div className="transcript-text">
                        {selected.text.split(/\n\n+/).map((p, i) => (
                          <p key={i}>{p}</p>
                        ))}
                      </div>
                    ) : (
                      <div className="transcript-empty">
                        <h2>
                          {selected.status === 'Completed'
                            ? 'No speech transcribed'
                            : 'Waiting for transcription'}
                        </h2>
                        <p>
                          {selected.status === 'Completed'
                            ? 'The transcript for this recording is empty.'
                            : 'Audio is saved. The transcription daemon will process it separately.'}
                        </p>
                      </div>
                    )}
                    <p className="transcript-caption">
                      Automatic transcription · Word timestamps unavailable
                    </p>
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
                          : (selected.duration_ms ?? 0) / 1000,
                      )
                    }
                  }}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onEnded={() => setPlaying(false)}
                  onError={() =>
                    setAudioError('Audio could not be loaded. Try refreshing or downloading it.')
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
                  <span>−{clock(Math.max(0, duration - position))}</span>
                </div>
                <div className="transport">
                  <span className="audio-kind">Original Opus</span>
                  <div className="transport-buttons">
                    <button
                      className="skip"
                      aria-label="Back 5 seconds"
                      disabled={!selected.has_audio}
                      onClick={() => seek(position - 5)}
                    >
                      <Icon name="back" />
                      <span>5</span>
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
                    <select
                      aria-label="Playback speed"
                      value={rate}
                      onChange={(e) => {
                        const v = +e.target.value
                        setRate(v)
                        if (audio.current) audio.current.playbackRate = v
                      }}
                    >
                      {[0.75, 1, 1.25, 1.5, 2].map((v) => (
                        <option key={v} value={v}>
                          {v}×
                        </option>
                      ))}
                    </select>
                  </div>
                  <span className="private-label">Your private recorder</span>
                </div>
                {audioError && (
                  <p className="error" role="alert">
                    {audioError}
                  </p>
                )}
              </footer>
            </>
          ) : (
            <section className="welcome">
              <Icon name="note" />
              <h1>Your words, within reach.</h1>
              <p>Select a recording to listen and read its transcript.</p>
            </section>
          )}
        </main>
      </div>
      {devices && (
        <div
          className="modal-backdrop"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setDevices(false)
              setCredentials(null)
            }
          }}
        >
          <section
            className="devices-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="devices-title"
          >
            <div className="dialog-heading">
              <h2 id="devices-title">Connect a device</h2>
              <button
                autoFocus
                className="icon-button"
                aria-label="Close devices"
                onClick={() => {
                  setDevices(false)
                  setCredentials(null)
                }}
              >
                <Icon name="close" />
              </button>
            </div>
            <p>Keep Omi capture on your phone or desktop. Listen, search and read here.</p>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void api('/api/clients', {
                  method: 'POST',
                  body: JSON.stringify({ name: deviceName }),
                })
                  .then((c) => {
                    setCredentials(c)
                    setDeviceName('')
                    void api('/api/clients').then((v) => setKeys(v.results))
                  })
                  .catch((e) => setNotice(e.message))
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
              <button className="tonal">Create access key</button>
            </form>
            {credentials && (
              <div className="credentials">
                <p>Copy these to the client settings. The API key is only shown now.</p>
                {[
                  ['Upload URL', credentials.upload_url],
                  ['API key', credentials.secret],
                  ['Sites access token', credentials.access_token],
                ].map(([label, value]) => (
                  <label key={label}>
                    {label}
                    <input
                      readOnly
                      value={value ?? 'Not configured — add SITES_ACCESS_TOKEN in Sites secrets'}
                      onFocus={(e) => e.target.select()}
                    />
                  </label>
                ))}
              </div>
            )}
            <p>Notion is the source of truth. D1 and R2 are persistent caches.</p>
            <button className="tonal" disabled={syncing} onClick={() => void syncNotion(true)}>
              Rebuild cache from Notion
            </button>
            <div className="device-list">
              {keys.map((k) => (
                <div key={k.hash}>
                  <span>
                    {k.name}
                    <small>
                      {k.revoked ? 'Revoked' : new Date(k.created_at).toLocaleDateString()}
                    </small>
                  </span>
                  <button
                    disabled={!!k.revoked}
                    onClick={() =>
                      void api('/api/clients/' + k.hash, { method: 'DELETE' })
                        .then(() =>
                          setKeys(keys.map((v) => (v.hash === k.hash ? { ...v, revoked: 1 } : v))),
                        )
                        .catch((e) => setNotice(e.message))
                    }
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
      {syncing && (
        <div className="sync-progress" role="status">
          Syncing from Notion · {synced} recordings
          <button
            onClick={() => {
              stopSync.current = true
            }}
          >
            Pause after this recording
          </button>
        </div>
      )}
      {notice && (
        <div className="snackbar" role="status">
          {notice}
          <button onClick={() => setNotice('')}>Dismiss</button>
        </div>
      )}
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
