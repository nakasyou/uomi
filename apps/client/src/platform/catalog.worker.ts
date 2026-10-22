import {
  planChunks,
  type RecordIndex,
  type ChunkPlan,
  type PlanningProgress,
} from '../core/catalog'
const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage: (message: unknown) => void
}
let records: RecordIndex[] = []
let last = 0
let phase = ''
function report(value: PlanningProgress) {
  const now = Date.now()
  if (value.phase !== phase || value.completed === value.total || now - last >= 100) {
    scope.postMessage({ progress: value })
    last = now
    phase = value.phase
  }
}
scope.onmessage = (event) => {
  if (event.data.records) {
    records.push(...event.data.records)
    report({ phase: 'loading', completed: records.length, total: event.data.total ?? 0 })
    return
  }
  try {
    const plans: ChunkPlan[] = []
    for (const plan of planChunks(
      records,
      event.data.seconds,
      !!event.data.pendingOnly,
      false,
      (value) => report({ ...value, chunks: plans.length }),
    ))
      plans.push(plan)
    report({
      phase: 'planning',
      completed: records.length,
      total: records.length,
      chunks: plans.length,
    })
    scope.postMessage({ plans })
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) })
  } finally {
    records = []
  }
}
