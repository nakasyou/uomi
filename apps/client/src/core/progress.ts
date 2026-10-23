import type { SyncProgress } from './types'
export function syncProgressText(progress: SyncProgress | null): string {
  if (!progress) return 'Preparing sync…'
  if (progress.stage === 'upload' && progress.chunksTotal !== undefined)
    return `${progress.chunksSubmitted ?? 0} / ${progress.chunksTotal} chunks sent · ${progress.chunksCompleted ?? 0} saves confirmed · ${progress.chunksStaged ?? 0} awaiting confirmation`
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
  return `${progress.detail ?? (progress.stage === 'import' ? 'Saved locally' : 'Processing audio')} · ${count}${progress.plannedChunks !== undefined ? ` · ${progress.plannedChunks} chunks planned` : ''}${progress.chunksCompleted !== undefined ? ` · ${progress.chunksCompleted} chunks saved` : ''}`
}
