export type PipelineStage = 'prepare' | 'audio' | 'metadata' | 'attach'
export const pipelineStages: PipelineStage[] = ['prepare', 'audio', 'metadata', 'attach']
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
  handlers: Record<PipelineStage, (job: T) => Promise<void>>,
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
      await handlers[name](job)
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
      if (running.size >= concurrency * pipelineStages.length) await Promise.race(running)
    }
  } catch (error) {
    failed = true
    failure = error
  }
  // Never return while an in-flight attachment may still change local state.
  await Promise.all(running)
  if (failed) throw failure
}
