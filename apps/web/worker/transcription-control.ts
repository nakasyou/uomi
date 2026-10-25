import { ApiError, jobView } from './jobs.ts'
import { detailedTranscription } from './detailed-transcription.ts'

function validateArguments(args: any) {
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new ApiError('Arguments must be an object')
}

export function recordingId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value))
    throw new ApiError('id must be a recording ID (1–100 letters, digits or hyphens)')
  return value
}

export async function startDetailedTranscription(env: any, args: any) {
  validateArguments(args)
  const id = recordingId(args.id)
  if (args.retry !== undefined && typeof args.retry !== 'boolean')
    throw new ApiError('retry must be a boolean')
  const row = await env.DB.prepare('SELECT * FROM recordings WHERE id=?').bind(id).first()
  if (!row) throw new ApiError('Recording not found', 404, 'not_found')
  const result = await detailedTranscription(env, null, row, true, args.retry === true)
  return {
    id,
    detailed_status: result.detailed_status,
    detailed_error: result.detailed_error,
    detailed_transcription: result.detailed_transcription,
  }
}

/** Bounded metadata only: never return audio, transcript bodies or worker lease tokens. */
export async function transcriptionStatus(env: any, args: any = {}) {
  validateArguments(args)
  const clauses: string[] = [],
    values: any[] = []
  if (args.id !== undefined) {
    const id = recordingId(args.id)
    if (!(await env.DB.prepare('SELECT id FROM recordings WHERE id=?').bind(id).first()))
      throw new ApiError('Recording not found', 404, 'not_found')
    clauses.push('j.recording_id=?')
    values.push(id)
  }
  for (const [key, allowed] of [
    ['mode', ['standard', 'long', 'detailed']],
    ['status', ['queued', 'processing', 'retry', 'completed', 'failed']],
  ] as const) {
    if (args[key] === undefined) continue
    if (!(allowed as readonly unknown[]).includes(args[key])) throw new ApiError(`Invalid ${key}`)
    clauses.push(`j.${key}=?`)
    values.push(args[key])
  }
  const limit = args.limit ?? 20
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new ApiError('limit must be an integer between 1 and 100')
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''
  const summary = await env.DB.prepare(
    `SELECT j.mode,j.status,count(*) AS count FROM transcription_jobs j${where} GROUP BY j.mode,j.status ORDER BY j.mode,j.status`,
  )
    .bind(...values)
    .all()
  if (args.cursor !== undefined) {
    let cursor
    try {
      cursor = JSON.parse(atob(args.cursor))
    } catch {
      throw new ApiError('Invalid cursor')
    }
    if (
      !cursor ||
      !Number.isSafeInteger(cursor.updated_at) ||
      cursor.updated_at < 0 ||
      typeof cursor.id !== 'string' ||
      cursor.id.length > 120
    )
      throw new ApiError('Invalid cursor')
    clauses.push('(j.updated_at,j.id)<(?,?)')
    values.push(cursor.updated_at, cursor.id)
  }
  const rows = await env.DB.prepare(
    `SELECT j.*,r.title,r.recorded_at,r.duration_ms FROM transcription_jobs j JOIN recordings r ON r.id=j.recording_id${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ORDER BY j.updated_at DESC,j.id DESC LIMIT ?`,
  )
    .bind(...values, limit + 1)
    .all()
  const jobs = rows.results.slice(0, limit),
    last = jobs.at(-1)
  return {
    as_of: Date.now(),
    summary: summary.results,
    jobs: jobs.map((job: any) => ({
      ...jobView(job),
      max_attempts: job.max_attempts,
      title: job.title,
      recorded_at: job.recorded_at,
      duration_ms: job.duration_ms,
    })),
    next_cursor:
      rows.results.length > limit && last
        ? btoa(JSON.stringify({ updated_at: last.updated_at, id: last.id }))
        : null,
  }
}
