import { test, expect } from 'bun:test'
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CompletionOutbox, sitesCallback } from '../src/callbacks'
test('completion delivery survives restart and deletes only a committed receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'uomi-callback-')),
    id = 'a'.repeat(32),
    secret = 'private-secret'
  const config = {
    url: 'https://site.test/api/transcriber/completed',
    accessToken: 'private-sites-token',
  }
  let committed = false,
    calls = 0
  const fetcher = (async (url, init) => {
    calls++
    expect(url).toBe(config.url)
    expect(init?.redirect).toBe('manual')
    const headers = init?.headers as Record<string, string>
    expect(headers['OAI-Sites-Authorization']).toBe('Bearer private-sites-token')
    expect(headers['X-Uomi-Webhook-Secret']).toBe(secret)
    expect(JSON.parse(init!.body as string)).toEqual({ pageId: id })
    return committed
      ? Response.json({ saved: true })
      : Response.json({ accepted: true }, { status: 202 })
  }) as typeof fetch
  try {
    const outbox = new CompletionOutbox(dir, config, secret, async () => true, fetcher)
    await outbox.enqueue(id)
    await outbox.flush()
    expect((await readdir(dir)).filter((x) => x.endsWith('.json')).length).toBe(1)
    const state = JSON.parse(await readFile(join(dir, id + '.json'), 'utf8'))
    expect(state.attempts).toBe(1)
    state.nextAt = 0
    await writeFile(join(dir, id + '.json'), JSON.stringify(state))
    committed = true
    const restarted = new CompletionOutbox(dir, config, secret, async () => true, fetcher)
    await restarted.flush()
    expect(await readdir(dir)).toEqual([])
    expect(calls).toBe(2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('callback destination is trusted configuration and never follows redirects', () => {
  expect(() => sitesCallback('http://other.test', 'token')).toThrow()
  expect(() => sitesCallback('https://site.test?secret=bad', 'token')).toThrow()
  expect(() => sitesCallback('https://site.test', undefined)).toThrow()
  expect(sitesCallback('https://site.test/', 'token')?.url).toBe(
    'https://site.test/api/transcriber/completed',
  )
})

test('recovery never delivers pending or failed transcripts, then delivers once Completed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'uomi-callback-ready-')),
    id = 'b'.repeat(32)
  const config = {
    url: 'https://site.test/api/transcriber/completed',
    accessToken: 'private-token',
  }
  let status = 'Processing',
    calls = 0
  const ready = async () => status === 'Completed'
  const fetcher = (async (_url, _init) => {
    calls++
    return Response.json({ saved: true })
  }) as typeof fetch
  try {
    await new CompletionOutbox(dir, config, 'secret', ready, fetcher).enqueue(id)
    // Simulate startup recovery of an entry created by the old daemon.
    const restarted = new CompletionOutbox(dir, config, 'secret', ready, fetcher)
    await restarted.flush()
    status = 'Failed'
    await restarted.flush()
    expect(calls).toBe(0)
    expect(JSON.parse(await readFile(join(dir, id + '.json'), 'utf8'))).toEqual({
      attempts: 0,
      nextAt: 0,
    })
    status = 'Completed'
    await restarted.flush()
    expect(calls).toBe(1)
    expect(await readdir(dir)).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('a waiting transcript cannot block another completed notification', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'uomi-callback-order-')),
    waiting = 'a'.repeat(32),
    done = 'b'.repeat(32)
  const config = {
    url: 'https://site.test/api/transcriber/completed',
    accessToken: 'private-token',
  }
  const sent: string[] = []
  const fetcher = (async (_url, init) => {
    sent.push(JSON.parse(init!.body as string).pageId)
    return Response.json({ saved: true })
  }) as typeof fetch
  try {
    const outbox = new CompletionOutbox(dir, config, 'secret', async (id) => id === done, fetcher)
    await outbox.enqueue(waiting)
    await outbox.enqueue(done)
    await outbox.flush(1)
    expect(sent).toEqual([done])
    expect(await readdir(dir)).toEqual([waiting + '.json'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
