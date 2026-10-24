import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { transcribeSpeech } from '../src/speech-transcription'
import { audioProcess, WorkSlots } from '../src/process'
import type { SpeechInterval } from '../src/speech-plan'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const signal = () => new AbortController().signal
const segment = (start_ms: number, end_ms: number, speaker: string | null): SpeechInterval => ({
  start_ms,
  end_ms,
  speaker,
})

async function fixture(segments: SpeechInterval[]) {
  const root = await mkdtemp(join(tmpdir(), 'uomi-speech-integration-'))
  try {
    const audioPath = join(root, 'original.ogg'),
      stateDir = join(root, 'state'),
      helper = join(root, 'helper')
    await mkdir(stateDir)
    await audioProcess(
      [
        'ffmpeg',
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=4.5',
        '-c:a',
        'libopus',
        audioPath,
      ],
      signal(),
    )
    const audioSha = createHash('sha256')
      .update(await readFile(audioPath))
      .digest('hex')
    await writeFile(
      helper,
      `#!${process.execPath}\nconst args=process.argv.slice(2);await Bun.write(args[args.indexOf('--output')+1],JSON.stringify(${JSON.stringify({ schema: 'uomi.speech-plan.v1', duration_ms: 4500, engine_version: 'fake-fluid-v1/model-sha-fixed', segments })}));\n`,
      { mode: 0o700 },
    )
    let run = 0
    return {
      root,
      audioPath,
      audioSha,
      stateDir,
      async options() {
        const directory = join(root, `work-${run++}`)
        await mkdir(directory)
        return {
          audioPath,
          directory,
          stateDir,
          helper,
          audioSha,
          recordingId: 'synthetic-test',
          mode: 'standard',
          language: 'ja',
          durationMs: 4500,
          splitSeconds: 600,
          timeoutMs: 5000,
          signal: signal(),
          analyze: async <T>(work: () => Promise<T>) => work(),
          stage: async (_stage: string, _progress: number) => {},
        }
      },
      async unchanged() {
        expect(
          createHash('sha256')
            .update(await readFile(audioPath))
            .digest('hex'),
        ).toBe(audioSha)
      },
      async cleanup() {
        await rm(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function duration(path: string) {
  const child = Bun.spawn(
    ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const output = await new Response(child.stdout).text()
  expect(await child.exited).toBe(0)
  return Number(JSON.parse(output).format.duration)
}

const indexOf = (path: string) => Number(basename(path).match(/^speech-(\d+)\.flac$/)?.[1])

test('actual FLAC trims preserve gaps, speakers and source order despite out-of-order recognition', async () => {
  const f = await fixture([segment(0, 1000, 'speaker1'), segment(3000, 4000, 'speaker2')])
  const bothStarted = deferred(),
    secondFinished = deferred()
  let active = 0,
    maximum = 0,
    started = 0
  const finishOrder: number[] = []
  try {
    const result = await transcribeSpeech({
      ...(await f.options()),
      recognize: async (path, options) => {
        const index = indexOf(path)
        active++
        maximum = Math.max(maximum, active)
        if (++started === 2) bothStarted.resolve()
        await bothStarted.promise
        expect(await duration(path)).toBeCloseTo(1, 2)
        expect(options.provider).toBe('chrome-recognizetion')
        expect(options.language).toBe('ja')
        if (index === 0) await secondFinished.promise
        finishOrder.push(index)
        active--
        if (index === 1) secondFinished.resolve()
        return {
          text: `text-${index}`,
          segments: [
            {
              start_ms: 100,
              end_ms: 900,
              text: `text-${index}`,
              speaker: 'untrusted-provider-speaker',
            },
          ],
        }
      },
    })
    expect(maximum).toBe(2)
    expect(finishOrder).toEqual([1, 0])
    expect(result.text).toBe('text-0\ntext-1')
    expect(result.segments).toEqual([
      { start_ms: 100, end_ms: 900, text: 'text-0', speaker: 'speaker1' },
      { start_ms: 3100, end_ms: 3900, text: 'text-1', speaker: 'speaker2' },
    ])
    expect((await readdir(join(f.root, 'work-0'))).some((name) => name.endsWith('.flac'))).toBe(
      false,
    )
    await f.unchanged()
  } finally {
    await f.cleanup()
  }
}, 20_000)

test('all-silence helper plan performs no recognition', async () => {
  const f = await fixture([])
  let calls = 0
  try {
    const result = await transcribeSpeech({
      ...(await f.options()),
      recognize: async () => {
        calls++
        throw Error('must not recognize silence')
      },
    })
    expect(calls).toBe(0)
    expect(result.text).toBe('')
    expect(result.segments).toEqual([])
    await f.unchanged()
  } finally {
    await f.cleanup()
  }
}, 20_000)

test('a failing slice preserves a concurrent successful checkpoint and retry recognizes only missing audio', async () => {
  const f = await fixture([segment(0, 1000, 'speaker1'), segment(3000, 4000, null)])
  const bothStarted = deferred(),
    failed = deferred()
  let started = 0
  try {
    await expect(
      transcribeSpeech({
        ...(await f.options()),
        recognize: async (path) => {
          const index = indexOf(path)
          if (++started === 2) bothStarted.resolve()
          await bothStarted.promise
          if (index === 0) {
            failed.resolve()
            throw Error('synthetic provider failure')
          }
          await failed.promise
          await new Promise((resolve) => setTimeout(resolve, 20))
          return { text: 'retained success', segments: [] }
        },
      }),
    ).rejects.toThrow('synthetic provider failure')
    const checkpointNames = (await readdir(f.stateDir)).filter((name) => name.startsWith('api-'))
    expect(checkpointNames).toHaveLength(1)
    expect(JSON.parse(await readFile(join(f.stateDir, checkpointNames[0]), 'utf8'))).toEqual([
      null,
      { text: 'retained success', segments: [] },
    ])
    const retried: number[] = []
    const result = await transcribeSpeech({
      ...(await f.options()),
      recognize: async (path) => {
        retried.push(indexOf(path))
        return { text: 'retried slice', segments: [] }
      },
    })
    expect(retried).toEqual([0])
    expect(result.text).toBe('retried slice\nretained success')
    expect(result.segments).toEqual([
      { start_ms: 0, end_ms: 1000, speaker: 'speaker1', text: 'retried slice' },
      { start_ms: 3000, end_ms: 4000, speaker: null, text: 'retained success' },
    ])
    await f.unchanged()
  } finally {
    await f.cleanup()
  }
}, 20_000)

test('shared recognition slots cap separate jobs at two with per-job parallel workers', async () => {
  const f = await fixture([
    segment(0, 500, 'a'),
    segment(1000, 1500, 'b'),
    segment(3000, 4000, 'a'),
  ])
  const slots = new WorkSlots(2)
  let active = 0,
    maximum = 0,
    calls = 0
  const recognize = async (path: string) =>
    slots.run(signal(), async () => {
      active++
      maximum = Math.max(maximum, active)
      calls++
      expect(await duration(path)).toBeGreaterThan(0)
      await new Promise((resolve) => setTimeout(resolve, 15))
      active--
      return { text: 'speech', segments: [] }
    })
  try {
    const first = await f.options(),
      second = await f.options()
    // Independent jobs have separate checkpoint identities but share native ASR capacity.
    second.recordingId = 'synthetic-second-job'
    const results = await Promise.all([
      transcribeSpeech({ ...first, recognize }),
      transcribeSpeech({ ...second, recognize }),
    ])
    expect(calls).toBe(6)
    expect(maximum).toBe(2)
    expect(results.every((result) => result.segments.length === 3)).toBe(true)
    await f.unchanged()
  } finally {
    await f.cleanup()
  }
}, 20_000)

test('aborted queued work never runs and cannot consume another waiter’s capacity', async () => {
  const slots = new WorkSlots(1),
    held = deferred(),
    cancelled = new AbortController()
  let cancelledRan = false,
    nextRan = false
  const first = slots.run(signal(), async () => held.promise)
  const rejected = slots.run(cancelled.signal, async () => {
    cancelledRan = true
  })
  const rejection = rejected.then(
    () => {
      throw Error('cancelled work resolved')
    },
    (error) => {
      expect(error.message).toBe('cancel queued')
    },
  )
  const next = slots.run(signal(), async () => {
    nextRan = true
  })
  cancelled.abort(new Error('cancel queued'))
  await rejection
  held.resolve()
  await Promise.all([first, next])
  expect(cancelledRan).toBe(false)
  expect(nextRan).toBe(true)
})

test('cancellation during capacity handoff forwards the free slot to the next job', async () => {
  const slots = new WorkSlots(1),
    release = deferred(),
    cancelled = new AbortController()
  let abortedRan = false,
    followingRan = false
  const first = slots.run(signal(), async () => {
    await release.promise
    // Abort after run() releases capacity and wakes this waiter, but before the
    // waiter resumes. This exercises the handoff race without timers.
    queueMicrotask(() => queueMicrotask(() => cancelled.abort(new Error('abort at handoff'))))
  })
  const aborted = slots.run(cancelled.signal, async () => {
    abortedRan = true
  })
  const rejection = aborted.then(
    () => {
      throw Error('handoff cancellation resolved')
    },
    (error) => {
      expect(error.message).toBe('abort at handoff')
    },
  )
  const following = slots.run(signal(), async () => {
    followingRan = true
  })
  release.resolve()
  await Promise.all([first, rejection, following])
  expect(abortedRan).toBe(false)
  expect(followingRan).toBe(true)
})

test('one recording never launches more than two slice recognizers', async () => {
  const f = await fixture([
    segment(0, 500, 'a'),
    segment(1000, 1500, 'b'),
    segment(3000, 4000, 'a'),
  ])
  let active = 0,
    maximum = 0,
    calls = 0
  try {
    const result = await transcribeSpeech({
      ...(await f.options()),
      recognize: async () => {
        active++
        maximum = Math.max(maximum, active)
        calls++
        await new Promise((resolve) => setTimeout(resolve, 30))
        active--
        return { text: 'speech', segments: [] }
      },
    })
    expect(calls).toBe(3)
    expect(maximum).toBe(2)
    expect(result.segments).toHaveLength(3)
    await f.unchanged()
  } finally {
    await f.cleanup()
  }
}, 20_000)

test('speech completion distinguishes VAD silence from empty recognition and retries transient slice errors', async () => {
  const silence = await fixture([])
  const speech = await fixture([segment(100, 1000, 'speaker0')])
  try {
    const noSpeech = await transcribeSpeech({
      ...(await silence.options()),
      recognize: async () => {
        throw Error('must not call')
      },
    })
    expect(noSpeech.outcome).toBe('no_speech')
    let calls = 0
    const empty = await transcribeSpeech({
      ...(await speech.options()),
      recognize: async () => {
        calls++
        if (calls === 1)
          throw Object.assign(Error('Did not receive an upstream request with matching pair ID'), {
            status: 400,
          })
        if (calls === 2) throw Object.assign(Error('temporary server failure'), { status: 500 })
        return { text: '' }
      },
    })
    expect(calls).toBe(3)
    expect(empty.outcome).toBe('empty')
    expect(empty.text).toBe('')
    expect(empty.segments).toEqual([])
  } finally {
    await silence.cleanup()
    await speech.cleanup()
  }
}, 15000)

test('speech progress exposes concurrent interval positions and exact completed counts', async () => {
  const f = await fixture([segment(100, 1000, 'one'), segment(3100, 3900, 'two')])
  const updates: any[] = []
  try {
    const result = await transcribeSpeech({
      ...(await f.options()),
      stage: async (stage, progress, detail) => {
        updates.push(JSON.parse(JSON.stringify({ stage, progress, detail })))
      },
      recognize: async (path, _options, _signal, onStart) => {
        await onStart?.()
        if (path.endsWith('speech-0.flac')) await new Promise((r) => setTimeout(r, 30))
        return { text: 'ok' }
      },
    })
    {
      const stages = updates.filter((x) => x.stage === 'transcribing')
      expect(
        stages.some(
          (x) =>
            x.detail.active.length === 2 &&
            x.detail.active.every((a: any) => a.state === 'transcribing'),
        ),
      ).toBe(true)
      expect(stages.at(-1).detail).toEqual({ completed: 2, total: 2, active: [] })
      expect(
        stages.some((x) => x.detail.active.some((a: any) => a.index === 2 && a.start_ms === 3100)),
      ).toBe(true)
    }
    expect(result.outcome).toBe('transcribed')
  } finally {
    await f.cleanup()
  }
}, 15000)

test('long mode retains pauses in a single source crop, returns text only, and isolates checkpoints', async () => {
  const f = await fixture([segment(100, 1000, 'one'), segment(2000, 4000, 'two')])
  try {
    const recognize = async (path: string) => {
      expect(await duration(path)).toBeCloseTo(3.9, 2)
      return {
        text: 'long passage',
        segments: [{ start_ms: 0, end_ms: 200, text: 'provider time' }],
      }
    }
    const long = await transcribeSpeech({ ...(await f.options()), mode: 'long', recognize })
    expect(long.text).toBe('long passage')
    expect(long.segments).toEqual([])
    expect(long.outcome).toBe('transcribed')
    const cached = await transcribeSpeech({
      ...(await f.options()),
      mode: 'long',
      recognize: async () => {
        throw Error('must reuse checkpoint')
      },
    })
    expect(cached.text).toBe(long.text)
    const standard = await transcribeSpeech({
      ...(await f.options()),
      recognize: async () => ({ text: 'standard' }),
    })
    expect(standard.checkpoint).not.toBe(long.checkpoint)
    expect(standard.segments).toHaveLength(2)
    await f.unchanged()
  } finally {
    await f.cleanup()
  }
}, 15000)
