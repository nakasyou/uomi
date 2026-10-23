export type PipelineStage = 'prepare' | 'audio' | 'metadata' | 'attach' | 'verify' | 'notify'
export const pipelineStages: PipelineStage[] = [
  'prepare',
  'audio',
  'metadata',
  'attach',
  'verify',
  'notify',
]
export interface StageProgress {
  active: number
  queued: number
  completed: number
}
export type PipelineProgress = Record<PipelineStage, StageProgress>

// Each stage has its own two slots. Admission is bounded too: a slow network
// cannot cause preparation to retain the entire audio library in memory.
export async function runPipeline<T>(
  source: Iterable<T> | AsyncIterable<T>,
  handlers: Record<Exclude<PipelineStage, 'verify' | 'notify'>, (job: T) => Promise<void>> &
    Partial<Record<'verify' | 'notify', (job: T) => Promise<void>>>,
  publish: (progress: PipelineProgress) => void,
  concurrency = 2,
) {
  const state = Object.fromEntries(
    pipelineStages.map((s) => [s, { active: 0, queued: 0, completed: 0 }]),
  ) as PipelineProgress
  const queues = Object.fromEntries(pipelineStages.map((s) => [s, [] as (() => void)[]])) as Record<
    PipelineStage,
    (() => void)[]
  >
  const emit = () =>
    publish(Object.fromEntries(pipelineStages.map((s) => [s, { ...state[s] }])) as PipelineProgress)
  let failure: unknown
  let failed = false
  async function stage(name: PipelineStage, job: T) {
    state[name].queued++
    emit()
    await new Promise<void>((resolve) => {
      const start = () => {
        state[name].queued--
        state[name].active++
        emit()
        resolve()
      }
      if (state[name].active < concurrency) start()
      else queues[name].push(start)
    })
    try {
      if (failed) return
      await handlers[name]?.(job)
      state[name].completed++
    } catch (error) {
      if (!failed) {
        failure = error
        failed = true
      }
    } finally {
      state[name].active--
      queues[name].shift()?.()
      emit()
    }
  }
  const running = new Set<Promise<void>>()
  try {
    for await (const job of source) {
      if (failed) break
      const task = (async () => {
        for (const name of pipelineStages) {
          if (failed) break
          await stage(name, job)
        }
      })()
      running.add(task)
      void task.then(() => running.delete(task))
      if (running.size >= concurrency * 4) await Promise.race(running)
    }
  } catch (error) {
    failed = true
    failure = error
  }
  // Never return while an in-flight attachment may still change local state.
  await Promise.all(running)
  if (failed) throw failure
}

// Keep reconciliation bounded and drain active checks before propagating errors.
export async function forEachBounded<T>(
  source: Iterable<T> | AsyncIterable<T>,
  visit: (value: T) => Promise<void>,
  concurrency = 2,
) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw Error('Invalid concurrency')
  const running = new Set<Promise<void>>()
  let failed = false
  const failures: unknown[] = []
  try {
    for await (const value of source) {
      if (failed) break
      const task = Promise.resolve()
        .then(() => visit(value))
        .catch((error) => {
          failures.push(error)
          failed = true
        })
      running.add(task)
      void task.then(() => running.delete(task))
      if (running.size >= concurrency) await Promise.race(running)
    }
  } catch (error) {
    failures.push(error)
    failed = true
  }
  await Promise.all(running)
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1)
    throw Error(
      failures.map((error) => (error instanceof Error ? error.message : String(error))).join('\n'),
    )
}
