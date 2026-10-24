#!/usr/bin/env bun
import { mkdir, open, rm, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseProvider } from '@nakasyou/ntranscribe'
import { hostname } from 'node:os'
import { ApiWorker, errorDetail } from './api-worker'

if (process.argv.includes('--help')) {
  console.log(
    'Uomi API transcriber\nUOMI_API_URL and UOMI_CLIENT_SECRET are required.\nTRANSCRIBER_PROVIDER=chrome-recognition TRANSCRIBER_CONCURRENCY=2 TRANSCRIBER_SPLIT_SECONDS=600 TRANSCRIBER_CODEX_SPLIT_SECONDS=300\nClaims independent Chrome/Codex lanes; FluidAudio=1, Chrome=2, Codex=2 execution queues. Renews leases and reports progress/errors. Notion credentials and inbound webhooks are no longer used.\nRequires ffmpeg on PATH.',
  )
  process.exit(0)
}
const apiUrl = process.env.UOMI_API_URL
const secret = process.env.UOMI_CLIENT_SECRET
if (!apiUrl || !secret || secret.length < 24)
  throw Error('Set UOMI_API_URL and UOMI_CLIENT_SECRET (at least 24 characters).')
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
const splitSeconds = Number(process.env.TRANSCRIBER_SPLIT_SECONDS ?? 600)
const codexSplitSeconds = Number(process.env.TRANSCRIBER_CODEX_SPLIT_SECONDS ?? 300)
if (
  !Number.isFinite(wait) ||
  wait < 10 ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  !Number.isInteger(splitSeconds) ||
  splitSeconds < 1 ||
  splitSeconds > 1800 ||
  !Number.isInteger(codexSplitSeconds) ||
  codexSplitSeconds < 1 ||
  codexSplitSeconds > 1800
) {
  await rm(lockPath)
  throw Error(
    'Invalid PORT, REQUEST_WAIT_SECONDS (minimum 10), or provider split seconds (TRANSCRIBER_SPLIT_SECONDS / TRANSCRIBER_CODEX_SPLIT_SECONDS, 1–1800).',
  )
}
const concurrency = Number(process.env.TRANSCRIBER_CONCURRENCY ?? 2)
const pollMs = Number(process.env.TRANSCRIBER_POLL_SECONDS ?? 5) * 1000
if (
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > 8 ||
  !Number.isFinite(pollMs) ||
  pollMs < 1000
) {
  await rm(lockPath, { force: true })
  throw Error('TRANSCRIBER_CONCURRENCY must be 1–8; TRANSCRIBER_POLL_SECONDS must be at least 1.')
}
const provider = parseProvider(process.env.TRANSCRIBER_PROVIDER ?? 'chrome-recognition')
const fluidCommand = process.env.TRANSCRIBER_FLUID_COMMAND ?? 'uomi-fluid-segments'
if (provider !== 'codex' && !Bun.which(fluidCommand)) {
  await rm(lockPath, { force: true })
  throw Error(
    'FluidAudio helper is unavailable. Set TRANSCRIBER_FLUID_COMMAND to uomi-fluid-segments; Chrome speech analysis cannot be skipped.',
  )
}
const daemon = new ApiWorker({
  url: apiUrl,
  secret,
  accessToken: process.env.SITES_ACCESS_TOKEN,
  workerId: process.env.TRANSCRIBER_WORKER_ID ?? hostname(),
  provider,
  language: process.env.LANGUAGE ?? 'ja',
  stateDir,
  concurrency,
  pollMs,
  requestWaitMs: wait * 1000,
  timeoutMs: 300000,
  splitSeconds,
  codexSplitSeconds,
  fluidCommand,
})
let server: ReturnType<typeof Bun.serve>
try {
  server = Bun.serve({
    hostname: process.env.HOST ?? '127.0.0.1',
    port,
    fetch(request) {
      const url = new URL(request.url)
      if (request.method === 'GET' && url.pathname === '/health')
        return Response.json({
          status: daemon.lastError ? 'degraded' : 'ok',
          provider: daemon.config.provider,
          ...daemon.status,
        })
      return Response.json(
        { error: 'This daemon pulls jobs from UOMI_API_URL; inbound webhooks have been removed.' },
        { status: 410 },
      )
    },
  })
} catch (error) {
  await rm(lockPath, { force: true })
  throw error
}
console.log(
  JSON.stringify({
    status: 'started',
    api: new URL(apiUrl).origin,
    concurrency: daemon.status.concurrency,
    queues: daemon.status.queues,
    workerId: daemon.config.workerId,
  }),
)
let stopping = false
let wake: (() => void) | undefined
const polling = (async () => {
  let failures = 0
  while (!stopping) {
    try {
      await daemon.poll()
      failures = 0
    } catch (error) {
      failures++
      console.error(JSON.stringify({ stage: 'claim', error: errorDetail(error), failures }))
    }
    if (stopping) break
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(60000, pollMs * 2 ** Math.min(failures, 4)))
      wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    wake = undefined
  }
})()
async function stop() {
  if (stopping) return
  stopping = true
  wake?.()
  server.stop()
  await polling
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
