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
        if (stage === 'attach') finished++
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
