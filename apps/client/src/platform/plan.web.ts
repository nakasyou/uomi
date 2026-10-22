import type { RecordIndex, ChunkPlan, PlanningProgress } from '../core/catalog'
import { workerSlot } from './worker-slot.web'
export function planAudio(
  records: RecordIndex[],
  seconds: number,
  pendingOnly = false,
  progress?: (value: PlanningProgress) => void,
): Promise<ChunkPlan[]> {
  return workerSlot(
    () =>
      new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./catalog.worker.ts', import.meta.url), {
          type: 'module',
        })
        const finish = (error?: Error, plans?: ChunkPlan[]) => {
          clearTimeout(timer)
          worker.terminate()
          if (error) reject(error)
          else resolve(plans!)
        }
        const timer = setTimeout(
          () => finish(Error('Recording planning timed out. Local audio is retained.')),
          120000,
        )
        worker.onmessage = (event) => {
          if (event.data.progress) progress?.(event.data.progress)
          else if (event.data.error) finish(Error(event.data.error))
          else finish(undefined, event.data.plans)
        }
        worker.onerror = () => finish(Error('Recording planner failed. Local audio is retained.'))
        worker.onmessageerror = () => finish(Error('Recording planner returned an invalid result.'))
        // Keep each structured clone small enough for the WebView to paint between
        // batches even when an offline device has hundreds of thousands of records.
        void (async () => {
          try {
            for (let start = 0; start < records.length; start += 256) {
              worker.postMessage({
                records: records.slice(start, start + 256),
                total: records.length,
              })
              await new Promise<void>((r) => setTimeout(r, 0))
            }
            worker.postMessage({ seconds, pendingOnly })
          } catch (error) {
            finish(error instanceof Error ? error : Error(String(error)))
          }
        })()
      }),
  )
}
