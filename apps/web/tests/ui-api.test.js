import { test } from 'node:test'
import assert from 'node:assert/strict'
import { api } from '../src/api.ts'
test('UI API retains HTTP status, operation and structured server request ID', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () =>
      Response.json({ error: 'Job lease expired', request_id: 'diagnostic-42' }, { status: 409 })
    await assert.rejects(
      api('/api/jobs/job/complete', { method: 'POST' }),
      /POST \/api\/jobs\/job\/complete · HTTP 409: Job lease expired \(request diagnostic-42\)/,
    )
  } finally {
    globalThis.fetch = original
  }
})
test('UI API reports gateway HTML and network failure rather than JSON parse errors', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response('<html>Sign in required</html>', { status: 403 })
    await assert.rejects(api('/api/recordings'), /HTTP 403: <html>Sign in required/)
    globalThis.fetch = async () => {
      throw Error('Network disconnected')
    }
    await assert.rejects(api('/api/recordings'), /GET \/api\/recordings: Network disconnected/)
  } finally {
    globalThis.fetch = original
  }
})

test('external cancellation does not remove the request deadline and custom Headers survive', async () => {
  const originalFetch = globalThis.fetch,
    originalTimeout = AbortSignal.timeout
  const deadline = new AbortController(),
    navigation = new AbortController()
  let requestedTimeout
  try {
    AbortSignal.timeout = (milliseconds) => {
      requestedTimeout = milliseconds
      return deadline.signal
    }
    globalThis.fetch = async (_path, options) => {
      assert.equal(options.headers.get('X-Test'), 'retained')
      assert.equal(options.headers.get('Content-Type'), 'application/custom+json')
      return new Promise((_resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        }),
      )
    }
    const request = api('/api/recordings/test/status', {
      signal: navigation.signal,
      headers: new Headers({ 'X-Test': 'retained', 'Content-Type': 'application/custom+json' }),
    })
    deadline.abort(new DOMException('Request deadline reached', 'TimeoutError'))
    await assert.rejects(request, /GET \/api\/recordings\/test\/status: Request deadline reached/)
    assert.equal(requestedTimeout, 30000)
    assert.equal(navigation.signal.aborted, false)
  } finally {
    globalThis.fetch = originalFetch
    AbortSignal.timeout = originalTimeout
  }
})

test('response stream failures and primitive gateway JSON retain their operation', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(Error('Connection lost during response'))
          },
        }),
        { status: 200 },
      )
    await assert.rejects(
      api('/api/recordings'),
      /GET \/api\/recordings · HTTP 200: response read failed: Connection lost/,
    )
    globalThis.fetch = async () => new Response('null', { status: 500 })
    await assert.rejects(
      api('/api/recordings'),
      /GET \/api\/recordings · HTTP 500: Expected a JSON object, received null/,
    )
  } finally {
    globalThis.fetch = original
  }
})
