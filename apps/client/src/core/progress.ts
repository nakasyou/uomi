import type { SyncProgress } from './types'
export function syncProgressText(progress: SyncProgress | null): string {
  if (!progress) return 'Preparing sync…'
  const unit =
    progress.unit ??
    (progress.stage === 'import'
      ? 'packets'
      : progress.stage === 'upload'
        ? 'frames'
        : 'recordings')
  const count =
    progress.total > 0
      ? `${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()} ${unit} · ${Math.floor((progress.completed / progress.total) * 100)}%`
      : `${progress.completed.toLocaleString()} ${unit} processed`
  return `${progress.detail ?? (progress.stage === 'import' ? 'Saved locally' : 'Saved in Notion')} · ${count}${progress.plannedChunks !== undefined ? ` · ${progress.plannedChunks} chunks planned` : ''}${progress.chunksCompleted !== undefined ? ` · ${progress.chunksCompleted} chunks saved` : ''}`
}
