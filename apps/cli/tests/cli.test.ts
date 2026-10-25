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
