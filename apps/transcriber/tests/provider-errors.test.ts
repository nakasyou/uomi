import { expect, test } from 'bun:test'
import { recognizeFlac, transcribe } from '@nakasyou/ntranscribe'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function flacHeader() {
  const audio = new Uint8Array(42)
  audio.set(new TextEncoder().encode('fLaC'))
  audio[7] = 34
  audio[18] = 3
  audio[19] = 232
  audio[21] = 240
  return audio
}

test('provider HTTP failures retain useful code/request ID and status while redacting credentials', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).includes('/up?')) return new Response()
    return Response.json(
      {
        error: {
          code: 400,
          status: 'INVALID_ARGUMENT',
          message:
            'Bad audio. Authorization: Bearer TOKEN_SECRET api_key=API_SECRET access_token=ACCESS_SECRET https://provider.invalid/check?key=QUERY_SECRET',
        },
      },
      { status: 400, headers: { 'x-request-id': 'rq-provider-123', 'retry-after': '60' } },
    )
  }) as typeof fetch
  let failure: any
  try {
    for await (const _event of recognizeFlac(flacHeader())) {
      /* No successful events expected. */
    }
  } catch (error) {
    failure = error
  } finally {
    globalThis.fetch = original
  }
  expect(failure.status).toBe(400)
  expect(failure.retryAfter).toBe('60')
  expect(failure.message).toContain('Speech downstream HTTP 400')
  expect(failure.message).toContain('INVALID_ARGUMENT')
  expect(failure.message).toContain('Bad audio')
  expect(failure.message).toContain('request_id=rq-provider-123')
  for (const secret of ['TOKEN_SECRET', 'API_SECRET', 'ACCESS_SECRET', 'QUERY_SECRET'])
    expect(failure.message).not.toContain(secret)
})

test('provider diagnostic reads are bounded and HTML bodies cannot flood stored job errors', async () => {
  const load = (url: string) => import(url)
  const { httpErrorDetail } = await load(
    new URL('../../../node_modules/@nakasyou/ntranscribe/src/http-error.ts', import.meta.url).href,
  )
  let reads = 0
  let cancelled = false
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++
        controller.enqueue(new TextEncoder().encode('<p>invalid audio</p>' + 'x'.repeat(9000)))
      },
      cancel() {
        cancelled = true
      },
    }),
    { status: 400 },
  )
  const detail = await httpErrorDetail(response)
  expect(detail).toContain('invalid audio')
  expect(detail.length).toBeLessThanOrEqual(1002)
  expect(reads).toBeLessThanOrEqual(2)
  expect(cancelled).toBe(true)
})

test('chunk errors preserve original HTTP status, retry metadata, and cause', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'uomi-provider-error-'))
  const path = join(directory, 'source.flac')
  const ffmpeg = Bun.spawn(
    [
      'ffmpeg',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=0.1',
      '-ac',
      '1',
      '-ar',
      '16000',
      path,
    ],
    { stdout: 'ignore', stderr: 'pipe' },
  )
  expect(await ffmpeg.exited).toBe(0)
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) =>
    String(url).includes('/up?')
      ? new Response()
      : Response.json(
          { error: { message: 'quota exhausted', code: 'quota_exceeded' } },
          { status: 429, headers: { 'retry-after': '120' } },
        )) as typeof fetch
  let failure: any
  try {
    await transcribe(path, { provider: 'chrome-recognizetion', splitSeconds: 600 })
  } catch (error) {
    failure = error
  } finally {
    globalThis.fetch = original
    await rm(directory, { recursive: true, force: true })
  }
  expect(failure.message).toContain('Chunk 1/1 failed')
  expect(failure.message).toContain('quota_exceeded')
  expect(failure.status).toBe(429)
  expect(failure.retryAfter).toBe('120')
  expect(failure.cause).toBeInstanceOf(Error)
})

test('Chrome sends chunked HTTP without Content-Length and keeps short uploads open for pairing', async () => {
  const { createServer } = await import('node:http')
  const received: { chunked?: string; length?: string; duration: number; bytes: number }[] = []
  const pending = new Map<string, import('node:http').ServerResponse>()
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://local')
    const pair = url.searchParams.get('pair')!
    if (url.pathname.endsWith('/down')) {
      pending.set(pair, response)
      return
    }
    const started = Date.now()
    let bytes = 0
    for await (const chunk of request) bytes += chunk.length
    received.push({
      chunked: request.headers['transfer-encoding'],
      length: request.headers['content-length'],
      duration: Date.now() - started,
      bytes,
    })
    response.end()
    pending.get(pair)!.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as import('node:net').AddressInfo).port
  const original = globalThis.fetch
  globalThis.fetch = ((url: string | URL | Request, init: RequestInit) => {
    const local = new URL(String(url))
    local.protocol = 'http:'
    local.host = `127.0.0.1:${port}`
    return original(local, init)
  }) as typeof fetch
  try {
    for await (const _ of recognizeFlac(flacHeader())) {
      /* drain */
    }
    expect(received).toHaveLength(1)
    expect(received[0].chunked).toBe('chunked')
    expect(received[0].length).toBeUndefined()
    expect(received[0].bytes).toBe(42)
    expect(received[0].duration).toBeGreaterThan(500)
  } finally {
    globalThis.fetch = original
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
