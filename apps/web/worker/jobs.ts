import { normalizeSearch } from './search.js'

export class ApiError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = 'invalid_request',
  ) {
    super(message)
  }
}
export const jobView = (row: any) =>
  row && {
    id: row.id,
    recording_id: row.recording_id,
    mode: row.mode,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    attempt: row.attempt,
    error: row.error,
    lease_until: row.lease_until,
    updated_at: row.updated_at,
    available_at: row.available_at,
  }
export async function enqueue(env: any, recordingId: string, mode = 'standard', retry = false) {
  const now = Date.now(),
    id = `${recordingId}:${mode}`
  await env.DB.prepare(`INSERT INTO transcription_jobs(id,recording_id,mode,created_at,updated_at)
    SELECT ?,?,?,?,? FROM recordings WHERE id=? AND (?='detailed' OR status!='Completed' OR ?=1) ON CONFLICT(recording_id,mode) DO NOTHING`)
    .bind(id, recordingId, mode, now, now, recordingId, mode, Number(retry))
    .run()
  if (retry)
    await env.DB.prepare(`UPDATE transcription_jobs SET status='queued',stage='queued',error=NULL,
    progress=0,attempt=0,available_at=0,updated_at=? WHERE id=? AND status IN ('failed','completed')`)
      .bind(now, id)
      .run()
  return env.DB.prepare('SELECT * FROM transcription_jobs WHERE id=?').bind(id).first()
}
const leaseSeconds = (value: unknown) => {
  const n = value ?? 120
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 30 || n > 300)
    throw new ApiError('lease_seconds must be an integer between 30 and 300')
  return n
}
export function validateSegments(value: unknown, duration: number | null) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 20000)
    throw new ApiError('Invalid transcript segments')
  let previous = -1
  return value.map((s) => {
    if (
      !s ||
      !Number.isFinite(s.start_ms) ||
      !Number.isFinite(s.end_ms) ||
      s.start_ms < previous ||
      s.start_ms < 0 ||
      s.end_ms < s.start_ms ||
      (duration && s.end_ms > duration + 1000) ||
      typeof s.text !== 'string' ||
      s.text.length > 100000 ||
      (s.speaker != null && (typeof s.speaker !== 'string' || s.speaker.length > 200))
    )
      throw new ApiError('Segments require ordered start_ms/end_ms, text, and optional speaker')
    previous = s.start_ms
    return { start_ms: s.start_ms, end_ms: s.end_ms, text: s.text, speaker: s.speaker ?? null }
  })
}
export async function jobsApi(request: Request, env: any, data: any) {
  const url = new URL(request.url),
    now = Date.now()
  if (url.pathname === '/api/jobs' && request.method === 'GET') {
    const results = await env.DB.prepare(
      'SELECT * FROM transcription_jobs ORDER BY updated_at DESC,id DESC LIMIT 100',
    ).all()
    return { results: results.results.map(jobView) }
  }
  if (url.pathname === '/api/jobs/claim' && request.method === 'POST') {
    if (typeof data.worker_id !== 'string' || !data.worker_id.trim() || data.worker_id.length > 200)
      throw new ApiError('worker_id required (1–200 characters)')
    const limit = data.limit ?? 1,
      seconds = leaseSeconds(data.lease_seconds)
    if (!Number.isInteger(limit) || limit < 1 || limit > 8)
      throw new ApiError('limit must be between 1 and 8')
    const expired =
      await env.DB.prepare(`UPDATE transcription_jobs SET status='failed',stage='failed',error='Worker lease expired after maximum attempts',updated_at=?
      WHERE id IN(SELECT id FROM transcription_jobs WHERE status='processing' AND lease_until<=? AND attempt>=max_attempts ORDER BY lease_until,id LIMIT 100)
      RETURNING recording_id,mode`)
        .bind(now, now)
        .all()
    if (expired.results.length)
      await env.DB.batch(
        ['standard', 'detailed'].map((mode) =>
          env.DB.prepare(`UPDATE recordings SET ${mode === 'standard' ? "status='Failed'" : "detailed_status='Failed',detailed_error='Worker lease expired after maximum attempts'"}
      WHERE id IN(SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM transcription_jobs j WHERE j.recording_id=recordings.id AND j.mode=? AND j.status='failed')`).bind(
            JSON.stringify(
              expired.results.filter((j: any) => j.mode === mode).map((j: any) => j.recording_id),
            ),
            mode,
          ),
        ),
      )
    const token = crypto.randomUUID()
    // Each indexed lane contributes at most limit candidates. The final merge sorts
    // at most 16 rows, even when the historical job table contains millions.
    const claimed = await env.DB.prepare(`WITH candidates AS MATERIALIZED (
      SELECT * FROM (SELECT j.id,j.recording_id,j.available_at AS ready_at,j.created_at FROM transcription_jobs j
        JOIN recordings r ON r.id=j.recording_id WHERE j.status IN ('queued','retry') AND j.attempt<j.max_attempts
        AND j.available_at<=? AND r.audio_key IS NOT NULL ORDER BY j.available_at,j.created_at,j.id LIMIT ?)
      UNION ALL
      SELECT * FROM (SELECT j.id,j.recording_id,j.lease_until AS ready_at,j.created_at FROM transcription_jobs j
        JOIN recordings r ON r.id=j.recording_id WHERE j.status='processing' AND j.attempt<j.max_attempts
        AND j.lease_until<=? AND r.audio_key IS NOT NULL ORDER BY j.lease_until,j.created_at,j.id LIMIT ?)
    ) UPDATE transcription_jobs SET status='processing',worker_id=?,lease_token=?,lease_until=?,attempt=attempt+1,
      stage='downloading',progress=0,error=NULL,updated_at=? WHERE id IN(
      SELECT id FROM candidates ORDER BY ready_at,created_at,id LIMIT ?) RETURNING *`)
      .bind(now, limit, now, limit, data.worker_id, token, now + seconds * 1000, now, limit)
      .all()
    if (!claimed.results.length) return { jobs: [] }
    const metadata = await env.DB.prepare(
      'SELECT id,duration_ms FROM recordings WHERE id IN(SELECT value FROM json_each(?))',
    )
      .bind(JSON.stringify(claimed.results.map((j: any) => j.recording_id)))
      .all()
    const durations = new Map(metadata.results.map((r: any) => [r.id, r.duration_ms]))
    // At most two writes, independent of the number of claimed recordings.
    await env.DB.batch(
      ['standard', 'detailed'].map((mode) =>
        env.DB.prepare(`UPDATE recordings SET ${mode === 'standard' ? "status='Processing'" : "detailed_status='Processing'"}
      WHERE id IN(SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM transcription_jobs WHERE recording_id=recordings.id AND mode=? AND lease_token=? AND status='processing' AND lease_until>?)`).bind(
          JSON.stringify(
            claimed.results.filter((j: any) => j.mode === mode).map((j: any) => j.recording_id),
          ),
          mode,
          token,
          Date.now(),
        ),
      ),
    )
    const jobs = claimed.results.map((j: any) => ({
      ...jobView(j),
      lease_token: token,
      duration_ms: durations.get(j.recording_id),
      audio_url: `${url.origin}/api/recordings/${j.recording_id}/audio`,
      manifest_url: `${url.origin}/api/recordings/${j.recording_id}/manifest`,
    }))
    return { jobs }
  }
  const match = url.pathname.match(/^\/api\/jobs\/([^/]+)\/(heartbeat|complete|fail)$/)
  if (!match || request.method !== 'POST')
    throw new ApiError('Job endpoint not found', 404, 'not_found')
  const id = decodeURIComponent(match[1]),
    action = match[2]
  const job = await env.DB.prepare('SELECT * FROM transcription_jobs WHERE id=?').bind(id).first()
  if (!job) throw new ApiError('Job not found', 404, 'not_found')
  if (typeof data.lease_token !== 'string' || data.lease_token !== job.lease_token)
    throw new ApiError('Job lease was replaced; discard this result', 409, 'lease_conflict')
  if (action === 'complete' && job.status === 'completed') return { saved: true, duplicate: true }
  if (job.status !== 'processing' || job.lease_until <= now)
    throw new ApiError('Job lease expired; discard this result', 409, 'lease_conflict')
  if (action === 'heartbeat') {
    const seconds = leaseSeconds(data.lease_seconds)
    if (
      data.progress !== undefined &&
      (!Number.isFinite(data.progress) || data.progress < 0 || data.progress > 1)
    )
      throw new ApiError('progress must be between 0 and 1')
    if (data.stage !== undefined && (typeof data.stage !== 'string' || data.stage.length > 100))
      throw new ApiError('Invalid stage')
    const r = await env.DB.prepare(
      `UPDATE transcription_jobs SET lease_until=?,stage=?,progress=?,updated_at=? WHERE id=? AND lease_token=? AND status='processing' AND lease_until>?`,
    )
      .bind(
        now + seconds * 1000,
        data.stage ?? job.stage,
        data.progress ?? job.progress,
        now,
        id,
        data.lease_token,
        now,
      )
      .run()
    if (!r.meta.changes) throw new ApiError('Job lease replaced', 409, 'lease_conflict')
    return { lease_until: now + seconds * 1000 }
  }
  if (action === 'fail') {
    if (typeof data.error !== 'string' || !data.error.trim()) throw new ApiError('error required')
    const delay = data.retry_after_seconds ?? Math.min(3600, 15 * 2 ** job.attempt)
    if (!Number.isFinite(delay) || delay < 0 || delay > 86400)
      throw new ApiError('Invalid retry_after_seconds')
    const status = data.retryable !== false && job.attempt < job.max_attempts ? 'retry' : 'failed'
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE recordings SET ${job.mode === 'standard' ? "status='Failed'" : "detailed_status='Failed',detailed_error=?"} WHERE id=? AND EXISTS(SELECT 1 FROM transcription_jobs WHERE id=? AND lease_token=? AND status='processing' AND lease_until>?)`,
      ).bind(
        ...(job.mode === 'standard' ? [] : [data.error.slice(0, 4000)]),
        job.recording_id,
        id,
        data.lease_token,
        now,
      ),
      env.DB.prepare(
        `UPDATE transcription_jobs SET status=?,stage=?,error=?,available_at=?,lease_until=0,updated_at=? WHERE id=? AND lease_token=? AND status='processing' AND lease_until>?`,
      ).bind(
        status,
        status,
        data.error.slice(0, 4000),
        now + delay * 1000,
        now,
        id,
        data.lease_token,
        now,
      ),
    ])
    const current = await env.DB.prepare(
      'SELECT status,lease_token FROM transcription_jobs WHERE id=?',
    )
      .bind(id)
      .first()
    if (current.lease_token !== data.lease_token || current.status !== status)
      throw new ApiError('Job lease replaced', 409, 'lease_conflict')
    return { saved: true, status }
  }
  if (typeof data.text !== 'string' || data.text.length > 1000000)
    throw new ApiError('text required (maximum 1 million characters)')
  if (data.model != null && (typeof data.model !== 'string' || data.model.length > 200))
    throw new ApiError('Invalid model')
  const recording = await env.DB.prepare('SELECT duration_ms FROM recordings WHERE id=?')
    .bind(job.recording_id)
    .first()
  const segments = JSON.stringify(validateSegments(data.segments, recording.duration_ms))
  const update =
    job.mode === 'standard'
      ? "status='Completed',text=?,search_text=?,search_version=1,transcript_segments=?"
      : "detailed_status='Completed',detailed_text=?,detailed_error='',detailed_segments=?"
  const result = await env.DB.batch([
    env.DB.prepare(
      `UPDATE recordings SET ${update},primary_owned=1,revision=revision+1,edited_at=? WHERE id=? AND EXISTS(SELECT 1 FROM transcription_jobs WHERE id=? AND lease_token=? AND status='processing' AND lease_until>?)`,
    ).bind(
      data.text,
      ...(job.mode === 'standard' ? [normalizeSearch(data.text)] : []),
      segments,
      new Date(now).toISOString(),
      job.recording_id,
      id,
      data.lease_token,
      now,
    ),
    env.DB.prepare(
      `UPDATE transcription_jobs SET status='completed',stage='completed',progress=1,error=NULL,model=?,lease_until=0,updated_at=? WHERE id=? AND lease_token=? AND status='processing' AND lease_until>?`,
    ).bind(data.model ?? null, now, id, data.lease_token, now),
  ])
  if (!result[1].meta.changes) throw new ApiError('Job lease replaced', 409, 'lease_conflict')
  return { saved: true }
}
