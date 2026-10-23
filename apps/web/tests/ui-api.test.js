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
