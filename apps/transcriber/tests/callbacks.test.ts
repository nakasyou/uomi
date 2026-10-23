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
    const outbox = new CompletionOutbox(dir, config, secret, fetcher)
    await outbox.enqueue(id)
    await outbox.flush()
    expect((await readdir(dir)).filter((x) => x.endsWith('.json')).length).toBe(1)
    const state = JSON.parse(await readFile(join(dir, id + '.json'), 'utf8'))
    expect(state.attempts).toBe(1)
    state.nextAt = 0
    await writeFile(join(dir, id + '.json'), JSON.stringify(state))
    committed = true
    const restarted = new CompletionOutbox(dir, config, secret, fetcher)
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

test('standard and detailed completions for one recording remain independent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'uomi-callback-modes-'))
  const payloads: unknown[] = []
  const outbox = new CompletionOutbox(
    directory,
    { url: 'https://site.test/api/transcriber/completed', accessToken: 'access' },
    'secret',
    (async (_url, init) => {
      payloads.push(JSON.parse(String(init?.body)))
      return Response.json({ saved: true })
    }) as typeof fetch,
  )
  try {
    const id = 'a'.repeat(32)
    await outbox.enqueue(id)
    await outbox.enqueue(id, 'detailed')
    await outbox.flush()
    expect(payloads).toContainEqual({ pageId: id })
    expect(payloads).toContainEqual({ pageId: id, mode: 'detailed' })
    expect(payloads.length).toBe(2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
