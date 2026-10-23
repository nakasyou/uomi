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
) {
  if (start && !row.audio_key)
    throw new ApiError(
      'Import recording audio before requesting transcription',
      409,
      'audio_unavailable',
    )
  const job = start
    ? await enqueue(env, row.id, 'detailed', retry || row.detailed_status === 'Failed')
    : await env.DB.prepare(
        "SELECT * FROM transcription_jobs WHERE recording_id=? AND mode='detailed'",
      )
        .bind(row.id)
        .first()
  if (start && job.status === 'queued')
    await env.DB.prepare(
      "UPDATE recordings SET detailed_status='Pending',detailed_error='' WHERE id=?",
    )
      .bind(row.id)
      .run()
  return {
    detailed_status: job ? (statusNames[job.status] ?? job.status) : row.detailed_status,
    detailed_text: row.detailed_text,
    detailed_error: job?.error ?? row.detailed_error,
    detailed_transcription: jobView(job),
  }
}
