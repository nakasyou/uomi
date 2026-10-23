import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runPipeline, pipelineStages, type PipelineStage } from '../src/core/pipeline'

test('pipeline overlaps stages, caps every stage at two, and bounds admitted jobs', async () => {
  const active = Object.fromEntries(pipelineStages.map((s) => [s, 0])) as Record<
    PipelineStage,
    number
  >
  const maximum = { ...active }
  let admitted = 0
  let finished = 0
  let overlapping = false
  const order = new Map<number, string[]>()
  function* source() {
    for (let i = 0; i < 24; i++) {
      assert.ok(admitted - finished < 8)
      admitted++
      yield i
    }
  }
  const handlers = Object.fromEntries(
    pipelineStages.map((stage) => [
      stage,
      async (job: number) => {
        active[stage]++
        maximum[stage] = Math.max(maximum[stage], active[stage])
        if (Object.values(active).filter((n) => n > 0).length > 1) overlapping = true
        order.set(job, [...(order.get(job) ?? []), stage])
        await new Promise((resolve) => setTimeout(resolve, stage === 'prepare' ? 1 : 4))
        active[stage]--
        if (stage === 'notify') finished++
      },
    ]),
  ) as Record<PipelineStage, (job: number) => Promise<void>>
  let final: unknown
  await runPipeline(source(), handlers, (progress) => {
    for (const stage of pipelineStages) assert.ok(progress[stage].active <= 2)
    final = progress
  })
  assert.equal(finished, 24)
  assert.ok(overlapping)
  for (const stage of pipelineStages) assert.equal(maximum[stage], 2)
  for (const stages of order.values()) assert.deepEqual(stages, pipelineStages)
  for (const stage of pipelineStages)
    assert.deepEqual((final as any)[stage], { active: 0, queued: 0, completed: 24 })
})

test('pipeline drains started work and does not advance failed jobs to another stage', async () => {
  const attached: number[] = []
  let failedJobReachedMetadata = false
  let released = false
  const handlers = {
    prepare: async () => {},
    audio: async (job: number) => {
      if (job === 0) await new Promise((resolve) => setTimeout(resolve, 10))
      if (job === 1) throw Error('network failed')
    },
    metadata: async (job: number) => {
      if (job === 1) failedJobReachedMetadata = true
    },
    attach: async (job: number) => {
      attached.push(job)
    },
  }
  await assert.rejects(
    runPipeline(
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
      {
        ...handlers,
        audio: async (job) => {
          try {
            await handlers.audio(job)
          } finally {
            if (job === 0) released = true
          }
        },
      },
      () => {},
    ),
    /network failed/,
  )
  assert.ok(released)
  assert.equal(failedJobReachedMetadata, false)
  assert.deepEqual(attached, [])
})

test('slow verification and notification do not occupy attachment slots', async () => {
  let releaseVerify!: () => void
  let releaseNotify!: () => void
  let bothVerifying!: () => void
  let bothNotifying!: () => void
  let laterAttached!: () => void
  const verification = new Promise<void>((resolve) => {
    releaseVerify = resolve
  })
  const notification = new Promise<void>((resolve) => {
    releaseNotify = resolve
  })
  const verifying = new Promise<void>((resolve) => {
    bothVerifying = resolve
  })
  const notifying = new Promise<void>((resolve) => {
    bothNotifying = resolve
  })
  const attached = new Promise<void>((resolve) => {
    laterAttached = resolve
  })
  let verifyCount = 0
  let notifyCount = 0
  const seen: number[] = []
  const running = runPipeline(
    [0, 1, 2, 3],
    {
      prepare: async () => {},
      audio: async () => {},
      metadata: async () => {},
      attach: async (job) => {
        seen.push(job)
        if (seen.length === 4) laterAttached()
      },
      verify: async () => {
        if (++verifyCount === 2) bothVerifying()
        await verification
      },
      notify: async () => {
        if (++notifyCount === 2) bothNotifying()
        await notification
      },
    },
    () => {},
  )
  try {
    await verifying
    await attached
    assert.equal(verifyCount, 2)
    releaseVerify()
    await notifying
    assert.equal(notifyCount, 2)
    assert.deepEqual(seen, [0, 1, 2, 3])
  } finally {
    releaseVerify()
    releaseNotify()
    await running
  }
})

test('bounded reconciliation overlaps two checks and drains them on failure', async () => {
  const { forEachBounded } = await import('../src/core/pipeline')
  let release!: () => void
  let failing!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const failed = new Promise<void>((resolve) => {
    failing = resolve
  })
  let active = 0
  let maximum = 0
  const visited: number[] = []
  let drained = false
  async function* pages() {
    for (let i = 0; i < 10; i++) yield i
  }
  const running = forEachBounded(pages(), async (page) => {
    visited.push(page)
    maximum = Math.max(maximum, ++active)
    try {
      if (page === 0) {
        await blocked
        drained = true
      } else {
        failing()
        throw Error('verification failed')
      }
    } finally {
      active--
    }
  })
  const rejection = assert.rejects(running, /verification failed/)
  await failed
  assert.equal(maximum, 2)
  assert.equal(drained, false)
  release()
  await rejection
  assert.equal(drained, true)
  assert.deepEqual(visited, [0, 1])
})
