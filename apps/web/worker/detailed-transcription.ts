import { enqueue, jobView, ApiError } from './jobs.ts'
const statusNames: Record<string, string> = {
  queued: 'Pending',
  retry: 'Failed',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
}
export async function detailedTranscription(
  env: any,
  _ctx: any,
  row: any,
  start: boolean,
  retry = false,
  mode: 'detailed' | 'long' = 'detailed',
) {
  if (start && !row.audio_key)
    throw new ApiError(
      'Import recording audio before requesting transcription',
      409,
      'audio_unavailable',
    )
  const job = start
    ? await enqueue(env, row.id, mode, retry || row[`${mode}_status`] === 'Failed')
    : await env.DB.prepare('SELECT * FROM transcription_jobs WHERE recording_id=? AND mode=?')
        .bind(row.id, mode)
        .first()
  if (start && job.status === 'queued')
    await env.DB.prepare(
      `UPDATE recordings SET ${mode}_status='Pending',${mode}_error='' WHERE id=?`,
    )
      .bind(row.id)
      .run()
  return {
    [`${mode}_status`]: job ? (statusNames[job.status] ?? job.status) : row[`${mode}_status`],
    [`${mode}_text`]: row[`${mode}_text`],
    [`${mode}_error`]: job?.error ?? row[`${mode}_error`],
    [`${mode}_transcription`]: jobView(job),
  }
}
