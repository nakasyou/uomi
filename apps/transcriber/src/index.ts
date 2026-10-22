#!/usr/bin/env bun
import { mkdir, open, rm, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseProvider } from '@nakasyou/ntranscribe'
import { httpTransport, NotionStore } from '@uomi/notion'
import { authorized, Daemon } from './daemon'

if (process.argv.includes('--help')) {
  console.log(
    'Uomi transcriber\nNOTION_TOKEN, NOTION_DATABASE_ID, UOMI_WEBHOOK_SECRET are required.\nTRANSCRIBER_PROVIDER=codex | chrome-recognition\nHOST=127.0.0.1 PORT=8787 LANGUAGE=ja REQUEST_WAIT_SECONDS=10\nPending/Processing/Failed pages are recovered automatically at startup and every minute.\nRequires ffmpeg on PATH. Codex credentials stay on this machine.',
  )
  process.exit(0)
}
const token = process.env.NOTION_TOKEN
const database = process.env.NOTION_DATABASE_ID
const secret = process.env.UOMI_WEBHOOK_SECRET
if (!token || !database || !secret || secret.length < 24)
  throw Error(
    'Set NOTION_TOKEN, NOTION_DATABASE_ID and UOMI_WEBHOOK_SECRET (at least 24 characters).',
  )
const stateDir =
  process.env.TRANSCRIBER_STATE_DIR ?? join(homedir(), '.local/share/uomi-transcriber')
await mkdir(stateDir, { recursive: true, mode: 0o700 })
const lockPath = join(stateDir, 'daemon.lock')
async function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(lockPath, 'wx', 0o600)
      await file.writeFile(String(process.pid))
      await file.close()
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt) throw error
      const owner = await readFile(lockPath, 'utf8')
      const pid = Number(owner)
      if (!Number.isInteger(pid) || pid <= 0)
        throw Error('Invalid daemon lock. Check the state directory.')
      try {
        process.kill(pid, 0)
        throw Error('Another transcriber is already running.')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
      if ((await readFile(lockPath, 'utf8')) !== owner)
        throw Error('Daemon lock changed. Retry startup.')
      await rm(lockPath)
    }
  }
}
await acquireLock()
const wait = Number(process.env.REQUEST_WAIT_SECONDS ?? 10)
const port = Number(process.env.PORT ?? 8787)
if (!Number.isFinite(wait) || wait < 10 || !Number.isInteger(port) || port < 1 || port > 65535) {
  await rm(lockPath)
  throw Error('Invalid PORT or REQUEST_WAIT_SECONDS (minimum 10).')
}
const store = new NotionStore(httpTransport(token), database)
const daemon = new Daemon(store, {
  secret,
  provider: parseProvider(process.env.TRANSCRIBER_PROVIDER ?? 'codex'),
  language: process.env.LANGUAGE ?? 'ja',
  stateDir,
  requestWaitMs: wait * 1000,
  timeoutMs: 300000,
})
let server: ReturnType<typeof Bun.serve>
try {
  await store.setup()
  server = Bun.serve({
    hostname: process.env.HOST ?? '127.0.0.1',
    port,
    maxRequestBodySize: 8 * 1024 * 1024,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === 'GET' && url.pathname === '/health')
        return Response.json({ status: 'ok' })
      if (request.method !== 'POST' || !['/webhook', '/reserve'].includes(url.pathname))
        return new Response('Not found', { status: 404 })
      if (!authorized(request.headers.get('authorization'), secret))
        return new Response('Unauthorized', { status: 401 })
      try {
        if (url.pathname === '/reserve')
          return Response.json(await daemon.reserve(await request.json()))
        const body = (await request.json()) as { pageId?: string }
        const result = await daemon.accept(body.pageId)
        return Response.json(result, { status: 202 })
      } catch {
        return Response.json(
          {
            error: 'Cannot accept this page. Check the page ID, database access and upload status.',
          },
          { status: 400 },
        )
      }
    },
  })
  await daemon.recover()
} catch (error) {
  await rm(lockPath, { force: true })
  throw error
}
console.log(`Uomi transcriber listening on ${server.hostname}:${server.port}`)
let recovery: Promise<unknown> = Promise.resolve()
const recoveryTimer = setInterval(() => {
  recovery = daemon
    .recover()
    .catch(() => console.error('Notion recovery paused; retrying on the next interval.'))
}, 60000)
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  clearInterval(recoveryTimer)
  server.stop()
  await recovery
  await daemon.close()
  await rm(lockPath, { force: true })
  process.exit(0)
}
process.on('SIGINT', () => {
  void stop()
})
process.on('SIGTERM', () => {
  void stop()
})
