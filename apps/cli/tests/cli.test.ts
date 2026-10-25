import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnvFile } from '../src/config.ts'
import { run } from '../src/cli.ts'

interface Call {
  url: URL
  init: RequestInit
  headers: Headers
}

function harness(
  fetcher: typeof fetch,
  env: Record<string, string> = {
    UOMI_API_KEY: 'api-secret',
    UOMI_SITES_TOKEN: 'sites-token',
    UOMI_BASE_URL: 'https://api.test',
  },
) {
  const output: string[] = []
  const errors: string[] = []
  return {
    output,
    errors,
    text: () => output.join(''),
    errorText: () => errors.join(''),
    run: (args: string[], overrides: Record<string, unknown> = {}) =>
      run(args, {
        env,
        envFile: '/definitely/missing/uomi-env',
        fetch: fetcher,
        out: (chunk) =>
          output.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)),
        err: (chunk) =>
          errors.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)),
        ...overrides,
      }),
  }
}

function mockFetch(responder: (url: URL, init: RequestInit) => Response | Promise<Response>): {
  fetcher: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    calls.push({ url, init, headers: new Headers(init.headers) })
    return responder(url, init)
  }) as typeof fetch
  return { fetcher, calls }
}

test('search sends credentials and pagination, then renders results', async () => {
  const { fetcher, calls } = mockFetch(() =>
    Response.json({
      results: [
        {
          id: 'rec-1',
          title: 'Morning notes',
          recorded_at: Date.UTC(2026, 0, 2, 3, 4),
          status: 'Completed',
          preview: 'first line\nsecond line',
        },
      ],
      next_cursor: 'next-page',
    }),
  )
  const h = harness(fetcher)
  expect(await h.run(['search', 'hello world', '--limit', '5', '--cursor', 'abc'])).toBe(0)
  expect(calls).toHaveLength(1)
  expect(calls[0].url.origin).toBe('https://api.test')
  expect(calls[0].url.pathname).toBe('/api/recordings')
  expect(calls[0].url.searchParams.get('q')).toBe('hello world')
  expect(calls[0].url.searchParams.get('limit')).toBe('5')
  expect(calls[0].url.searchParams.get('cursor')).toBe('abc')
  expect(calls[0].headers.get('X-Uomi-Secret')).toBe('api-secret')
  expect(calls[0].headers.get('OAI-Sites-Authorization')).toBe('Bearer sites-token')
  expect(h.text()).toContain('rec-1')
  expect(h.text()).toContain('Morning notes')
  expect(h.text()).toContain('first line')
  expect(h.text()).toContain("--cursor 'next-page'")
})

test('show formats segment timestamps and speaker labels', async () => {
  const { fetcher } = mockFetch(() =>
    Response.json({
      id: 'rec-1',
      title: 'Conversation',
      recorded_at: Date.UTC(2026, 0, 2, 3, 4),
      duration_ms: 125000,
      status: 'Completed',
      has_audio: true,
      segments: [
        { start_ms: 5000, speaker: 'speaker1', text: 'Hello' },
        { start_ms: 65000, speaker: 'speaker2', text: 'World' },
      ],
    }),
  )
  const h = harness(fetcher)
  expect(await h.run(['show', 'rec-1'])).toBe(0)
  expect(h.text()).toContain('Title:    Conversation')
  expect(h.text()).toContain('[00:05] speaker1: Hello')
  expect(h.text()).toContain('[01:05] speaker2: World')
})

test('show --json prints the raw recording response', async () => {
  const { fetcher } = mockFetch(() => Response.json({ id: 'rec-1', segments: [] }))
  const h = harness(fetcher)
  expect(await h.run(['show', 'rec-1', '--json'])).toBe(0)
  expect(JSON.parse(h.text())).toEqual({ id: 'rec-1', segments: [] })
})

test('audio writes the response body to a file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'uomi-cli-audio-'))
  try {
    const path = join(directory, 'out.ogg')
    const { fetcher, calls } = mockFetch(
      () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
    )
    const h = harness(fetcher)
    expect(await h.run(['audio', 'rec-1', '-o', path])).toBe(0)
    expect(new Uint8Array(await readFile(path))).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(calls[0].url.pathname).toBe('/api/recordings/rec-1/audio')
    expect(h.text()).toContain(`Saved 4 bytes to ${path}`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('detailed start posts retry and status renders durable jobs', async () => {
  const { fetcher, calls } = mockFetch((url) => {
    if (url.pathname.endsWith('/detailed-transcription'))
      return Response.json(
        {
          id: 'rec-1',
          detailed_status: 'Pending',
          detailed_error: '',
          detailed_transcription: {
            id: 'rec-1:detailed',
            recording_id: 'rec-1',
            mode: 'detailed',
            status: 'queued',
            attempt: 0,
          },
        },
        { status: 202 },
      )
    return Response.json({
      as_of: Date.UTC(2026, 0, 2, 3, 4),
      summary: [{ mode: 'detailed', status: 'queued', count: 1 }],
      jobs: [
        {
          recording_id: 'rec-1',
          mode: 'detailed',
          status: 'queued',
          stage: 'queued',
          progress: 0.5,
          attempt: 1,
          max_attempts: 8,
          detail: { completed: 2, total: 4 },
          title: 'Conversation',
        },
      ],
      next_cursor: null,
    })
  })
  const h = harness(fetcher)
  expect(await h.run(['detailed', 'rec-1', '--retry'])).toBe(0)
  expect(calls[0].url.pathname).toBe('/api/recordings/rec-1/detailed-transcription')
  expect(calls[0].init.method).toBe('POST')
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ retry: true })
  expect(h.text()).toContain('Detailed status: Pending')

  const status = harness(fetcher)
  expect(await status.run(['status', 'rec-1', '--mode', 'detailed', '--limit', '5'])).toBe(0)
  expect(calls[1].url.pathname).toBe('/api/transcriptions')
  expect(calls[1].url.searchParams.get('id')).toBe('rec-1')
  expect(calls[1].url.searchParams.get('mode')).toBe('detailed')
  expect(calls[1].url.searchParams.get('limit')).toBe('5')
  expect(status.text()).toContain('detailed queued: 1')
  expect(status.text()).toContain('rec-1  detailed  queued')
  expect(status.text()).toContain('completed=2 total=4')
})

test('detailed-result reads the persisted result', async () => {
  const { fetcher, calls } = mockFetch(() =>
    Response.json({
      detailed_status: 'Completed',
      detailed_error: '',
      detailed_text: 'Detailed body',
      detailed_transcription: { status: 'completed', mode: 'detailed' },
    }),
  )
  const h = harness(fetcher)
  expect(await h.run(['detailed-result', 'rec-1'])).toBe(0)
  expect(calls[0].init.method).toBeUndefined()
  expect(calls[0].url.pathname).toBe('/api/recordings/rec-1/detailed-transcription')
  expect(h.text()).toContain('Detailed status: Completed')
  expect(h.text()).toContain('Detailed body')
})

test('mcp uses the device-key API alias for list and tools/call', async () => {
  const { fetcher, calls } = mockFetch((_url, init) => {
    const payload = JSON.parse(String(init.body))
    if (payload.method === 'tools/list')
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: { tools: [{ name: 'search_transcripts' }] },
      })
    return Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { jobs: [] },
      },
    })
  })
  const h = harness(fetcher)
  expect(await h.run(['mcp', '--list'])).toBe(0)
  expect(calls[0].url.pathname).toBe('/api/mcp')
  expect(JSON.parse(String(calls[0].init.body)).method).toBe('tools/list')
  expect(h.text()).toContain('search_transcripts')

  const call = harness(fetcher)
  expect(await call.run(['mcp', 'transcription_status', '--args', '{"mode":"detailed"}'])).toBe(0)
  const payload = JSON.parse(String(calls[1].init.body))
  expect(payload.method).toBe('tools/call')
  expect(payload.params).toEqual({
    name: 'transcription_status',
    arguments: { mode: 'detailed' },
  })
  expect(JSON.parse(call.text())).toEqual({ jobs: [] })
})

test('credentials fall back to the env file and sites token stays optional', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'uomi-cli-env-'))
  try {
    const envFile = join(directory, 'env')
    await writeFile(
      envFile,
      '# private settings\nUOMI_API_KEY="from-file"\nUOMI_SITES_TOKEN=site-file\nUOMI_BASE_URL=https://file.test/\n',
    )
    const { fetcher, calls } = mockFetch(() => Response.json({ results: [] }))
    const h = harness(fetcher)
    expect(await h.run(['search'], { env: {}, envFile })).toBe(0)
    expect(calls[0].url.origin).toBe('https://file.test')
    expect(calls[0].headers.get('X-Uomi-Secret')).toBe('from-file')
    expect(calls[0].headers.get('OAI-Sites-Authorization')).toBe('Bearer site-file')

    const optional = harness(fetcher, {
      UOMI_API_KEY: 'only-api-key',
      UOMI_BASE_URL: 'https://api.test',
    })
    expect(await optional.run(['search'])).toBe(0)
    expect(calls[1].headers.get('OAI-Sites-Authorization')).toBeNull()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('authentication errors and missing keys never expose secret values', async () => {
  const { fetcher } = mockFetch(() =>
    Response.json({ error: 'Authentication required' }, { status: 401 }),
  )
  const h = harness(fetcher)
  expect(await h.run(['search'])).toBe(1)
  expect(h.errorText()).toContain('HTTP 401: Authentication required')
  expect(h.errorText()).not.toContain('api-secret')
  expect(h.errorText()).not.toContain('sites-token')

  const missing = harness(fetcher, {})
  expect(await missing.run(['search'], { envFile: '/definitely/missing/uomi-env' })).toBe(1)
  expect(missing.errorText()).toContain('missing UOMI_API_KEY')
})

test('parseEnvFile accepts comments, quotes and empty values', () => {
  expect(
    parseEnvFile(`
# comment
A=one
B = "two"
C='three'
D=
not a setting
`),
  ).toEqual({ A: 'one', B: 'two', C: 'three', D: '' })
})

const HOUR = 3600000

function transcriptsApi(
  recordings: Record<string, Record<string, unknown>>,
  options: { pageSize?: number } = {},
) {
  const pageSize = options.pageSize ?? 50
  const newestFirst = Object.values(recordings).sort(
    (a, b) => Number(b.recorded_at) - Number(a.recorded_at),
  )
  return mockFetch((url) => {
    if (url.pathname === '/api/recordings') {
      const from = url.searchParams.get('from')
      const to = url.searchParams.get('to')
      const matching = newestFirst.filter(
        (recording) =>
          (!from ||
            Number(recording.recorded_at) + Number(recording.duration_ms) > Date.parse(from)) &&
          (!to || Number(recording.recorded_at) < Date.parse(to)),
      )
      const start = Number(url.searchParams.get('cursor') ?? 0)
      const page = matching.slice(start, start + pageSize)
      return Response.json({
        results: page.map(({ id, recorded_at, duration_ms }) => ({ id, recorded_at, duration_ms })),
        next_cursor: start + pageSize < matching.length ? String(start + pageSize) : null,
      })
    }
    const id = decodeURIComponent(url.pathname.split('/').pop() ?? '')
    const recording = recordings[id]
    if (!recording) return Response.json({ error: 'Recording not found' }, { status: 404 })
    return Response.json(recording)
  })
}

const base = new Date(2026, 9, 25, 9, 0).getTime()
const sample = {
  'rec-detailed': {
    id: 'rec-detailed',
    recorded_at: base + HOUR,
    duration_ms: 188000,
    segments: [{ start_ms: 0, speaker: 'speaker_1', text: 'standard words' }],
    text: 'standard words',
    detailed_segments: [{ start: 5000, speaker_label: 'speaker_2', text: 'detailed words' }],
    detailed_text: 'detailed words',
  },
  'rec-standard': {
    id: 'rec-standard',
    recorded_at: base + 2 * HOUR,
    duration_ms: 60000,
    segments: [{ start_ms: 65000, speaker: 'speaker_1', text: 'only standard' }],
    detailed_segments: [],
    detailed_text: '',
  },
  'rec-empty': {
    id: 'rec-empty',
    recorded_at: base + 3 * HOUR,
    duration_ms: 30000,
    segments: [],
    text: '',
    detailed_segments: [],
    detailed_text: '',
    long_text: '',
  },
  'rec-text': {
    id: 'rec-text',
    recorded_at: base + 4 * HOUR,
    duration_ms: 30000,
    segments: [],
    text: 'line one\nline two',
    detailed_segments: [],
  },
  'rec-long': {
    id: 'rec-long',
    recorded_at: base + 5 * HOUR,
    duration_ms: 30000,
    segments: [],
    text: '',
    long_text: 'long fallback',
  },
  'rec-old': {
    id: 'rec-old',
    recorded_at: base - 10 * HOUR,
    duration_ms: 30000,
    text: 'too old',
  },
}

test('transcripts prefers detailed, falls back, skips empty and prints oldest first', async () => {
  const { fetcher, calls } = transcriptsApi(sample)
  const h = harness(fetcher)
  expect(await h.run(['transcripts', '--after', '2026-10-25T09:00'])).toBe(0)
  const list = calls.filter((call) => call.url.pathname === '/api/recordings')
  expect(list).toHaveLength(1)
  expect(list[0].url.searchParams.get('limit')).toBe('50')
  expect(Date.parse(list[0].url.searchParams.get('from') ?? '')).toBe(base)
  expect(list[0].url.searchParams.get('to')).toBeNull()
  expect(h.text()).toBe(
    [
      '=== rec-detailed 2026-10-25 10:00 3m 8s [detailed] ===',
      '[00:05] speaker_2: detailed words',
      '=== rec-standard 2026-10-25 11:00 1m 0s [standard] ===',
      '[01:05] speaker_1: only standard',
      '=== rec-text 2026-10-25 13:00 30s [standard] ===',
      'line one',
      'line two',
      '=== rec-long 2026-10-25 14:00 30s [long] ===',
      'long fallback',
      '',
    ].join('\n'),
  )
  expect(h.text()).not.toContain('rec-empty')
  expect(h.text()).not.toContain('too old')
  expect(h.errorText()).toBe('')
})

test('transcripts accepts epoch milliseconds and relative ages for --after', async () => {
  const { fetcher, calls } = transcriptsApi(sample)
  const epoch = harness(fetcher)
  expect(await epoch.run(['transcripts', '--after', String(base + 3 * HOUR)])).toBe(0)
  expect(epoch.text()).not.toContain('rec-standard')
  expect(epoch.text()).toContain('rec-text')
  expect(Date.parse(calls[0].url.searchParams.get('from') ?? '')).toBe(base + 3 * HOUR)

  const now = base + 6 * HOUR
  for (const [age, after] of [
    ['90m', now - 90 * 60000],
    ['2h', now - 2 * HOUR],
    ['1d', now - 24 * HOUR],
  ] as const) {
    calls.length = 0
    const relative = harness(fetcher)
    expect(await relative.run(['transcripts', '--after', age], { now: () => now })).toBe(0)
    expect(Date.parse(calls[0].url.searchParams.get('from') ?? '')).toBe(after)
  }
  calls.length = 0
  const zoned = harness(fetcher)
  expect(await zoned.run(['transcripts', '--after', '2026-10-25T00:00:00Z'])).toBe(0)
  expect(calls[0].url.searchParams.get('from')).toBe('2026-10-25T00:00:00.000Z')
})

test('transcripts follows pagination and keeps chronological order', async () => {
  const recordings: Record<string, Record<string, unknown>> = {}
  for (let index = 0; index < 5; index++)
    recordings[`rec-${index}`] = {
      id: `rec-${index}`,
      recorded_at: base + index * HOUR,
      duration_ms: 1000,
      text: `body ${index}`,
    }
  const { fetcher, calls } = transcriptsApi(recordings, { pageSize: 2 })
  const h = harness(fetcher)
  expect(await h.run(['transcripts', '--after', String(base - HOUR)])).toBe(0)
  const list = calls.filter((call) => call.url.pathname === '/api/recordings')
  expect(list.map((call) => call.url.searchParams.get('cursor'))).toEqual([null, '2', '4'])
  expect(h.text().match(/^body \d$/gm)).toEqual(['body 0', 'body 1', 'body 2', 'body 3', 'body 4'])

  const limited = harness(fetcher)
  expect(await limited.run(['transcripts', '--after', String(base - HOUR), '--limit', '3'])).toBe(0)
  expect(limited.text().match(/^body \d$/gm)).toEqual(['body 2', 'body 3', 'body 4'])
})

test('transcripts stops at older recordings when the API ignores the time filter', async () => {
  const unfiltered = mockFetch((url) => {
    if (url.pathname === '/api/recordings')
      return Response.json({
        results: [
          { id: 'rec-new', recorded_at: base + HOUR, duration_ms: 1000 },
          { id: 'rec-old', recorded_at: base - HOUR, duration_ms: 1000 },
        ],
        next_cursor: 'never-followed',
      })
    return Response.json({ id: url.pathname.split('/').pop(), recorded_at: base, text: 'body' })
  })
  const h = harness(unfiltered.fetcher)
  expect(await h.run(['transcripts', '--after', String(base)])).toBe(0)
  const paths = unfiltered.calls.map((call) => call.url.pathname)
  expect(paths).toEqual(['/api/recordings', '/api/recordings/rec-new'])
})

test('transcripts supports --before alone and --after/--before ranges', async () => {
  const { fetcher, calls } = transcriptsApi(sample)
  const range = harness(fetcher)
  expect(
    await range.run([
      'transcripts',
      '--after',
      '2026-10-25T10:30',
      '--before',
      String(base + 4 * HOUR),
    ]),
  ).toBe(0)
  expect(Date.parse(calls[0].url.searchParams.get('from') ?? '')).toBe(base + 1.5 * HOUR)
  expect(Date.parse(calls[0].url.searchParams.get('to') ?? '')).toBe(base + 4 * HOUR)
  expect(range.text().match(/^=== (\S+)/gm)).toEqual(['=== rec-standard'])

  calls.length = 0
  const beforeOnly = harness(fetcher)
  expect(await beforeOnly.run(['transcripts', '--before', '2026-10-25T11:00'])).toBe(0)
  expect(calls[0].url.searchParams.get('from')).toBeNull()
  expect(beforeOnly.text().match(/^=== (\S+)/gm)).toEqual(['=== rec-old', '=== rec-detailed'])
})

test('transcripts --json prints one object per recording', async () => {
  const { fetcher } = transcriptsApi(sample)
  const h = harness(fetcher)
  expect(await h.run(['transcripts', '--after', '2026-10-25T09:00', '--json'])).toBe(0)
  const lines = h
    .text()
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(lines.map((line) => [line.id, line.source])).toEqual([
    ['rec-detailed', 'detailed'],
    ['rec-standard', 'standard'],
    ['rec-text', 'standard'],
    ['rec-long', 'long'],
  ])
  expect(lines[0].segments).toEqual([
    { start_ms: 5000, speaker: 'speaker_2', text: 'detailed words' },
  ])
  expect(lines[2].text).toBe('line one\nline two')
})

test('transcripts rejects invalid or missing time options before calling the API', async () => {
  const { fetcher, calls } = transcriptsApi(sample)
  for (const args of [
    ['--after', 'yesterday'],
    ['--after', '2026-13-01'],
    ['--after', '2h30'],
    ['--before', '-5m'],
    ['--after', '2h', '--before', '3h'],
    ['--after', '2026-10-25T10:00', '--before', '2026-10-25T10:00'],
    [],
  ]) {
    const h = harness(fetcher)
    expect(await h.run(['transcripts', ...args])).toBe(1)
    expect(h.errorText()).toStartWith('uomi: error: ')
    expect(h.text()).toBe('')
  }
  expect(calls).toHaveLength(0)
})

test('transcripts stops quietly when stdout is closed', async () => {
  const { fetcher } = transcriptsApi(sample)
  const h = harness(fetcher)
  const out = () => {
    throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
  }
  expect(await h.run(['transcripts', '--after', '2026-10-25T09:00'], { out })).toBe(0)
  expect(h.errorText()).toBe('')
})
