# Transcriber API transport

The daemon polls the private Uomi API. No public listener or webhook is needed.
Notion is not a queue, a source of transcription input, or a completion checkpoint.

## Configuration

Set `SITES_URL` to the existing private Site origin, `SITES_ACCESS_TOKEN` to that
Site's service token, and `UOMI_CLIENT_SECRET` to a key created in web device
settings, or a dedicated worker secret configured as `UOMI_WORKER_SECRET` in
Sites. The legacy `UOMI_WEBHOOK_SECRET` is accepted only when no dedicated worker
secret is configured. Worker credentials cannot upload, edit, or create client keys.
Requests use `X-OpenAI-Site-Access-Token` and `X-Uomi-Secret`.
Keep these credentials on the daemon host; never commit `.env` or embed provider
credentials into web assets. ffmpeg and provider dependencies run on that host.

## Protocol

1. `POST /api/jobs/claim` with `{worker_id,limit,lease_seconds}` atomically selects
   due jobs. Default limit is one (maximum eight); lease duration is 30–300 seconds.
   The daemon normally bounds parallelism to two jobs.
2. Each claimed job contains `id`, `recording_id`, `mode`, `attempt`, `lease_token`,
   `lease_until`, `duration_ms`, `audio_url` and `manifest_url`. Fetch URLs with the
   same authentication, validate the manifest and original-audio SHA-256.
3. `POST /api/jobs/:id/heartbeat` with `{lease_token,stage,progress,lease_seconds}`
   renews ownership. Progress is 0–1. The web app reads the persisted stage/progress
   rather than inferring completion from request delivery.
4. `POST /api/jobs/:id/complete` with `{lease_token,text,segments?,model?}` commits
   the transcript and completed job transactionally. A repeated receipt for the
   same completed lease succeeds; expired/replaced leases return 409.
5. `POST /api/jobs/:id/fail` with `{lease_token,error,retryable?,retry_after_seconds?}`
   records the actual cause. Retry delay defaults to bounded exponential backoff;
   maximum eight attempts. Failed jobs remain visible and can be manually retried.

A process crash leaves an expiring lease. Another worker reclaims it with a new
opaque token. Every heartbeat/result/failure is fenced by the current lease.
The daemon stores completed chunk work locally so an interrupted recording can
resume without repeating already finished provider calls. HTTP failures include
status, server error and request ID; provider failures remain in job state.

Standard and detailed jobs are separate unique `(recording_id,mode)` records.
Detailed output never replaces standard text. Optional segments use
`{start_ms,end_ms,text,speaker?:string|null}` on the original recording timeline,
including source gaps. Provider-supplied timestamps are preserved; plain text
never produces invented timing/speaker assignments.

## Release migration

Apply web migrations through `0007_notion_cutover.sql` before starting the API worker.
The job migration creates jobs for existing unfinished recordings with primary
audio. The cutover migration prevents stale historical snapshots from being
backed up into Notion and permits one guarded source refresh. Import
older Notion history through worker-authenticated `/api/migrations/notion`: POST
`{reset:true}` only on the first request, then POST `{}` until `has_more:false`.
GET the same endpoint for persisted status/error. Do not reset between batches; imported pending
audio also receives a job. Verify a claim, heartbeat, completion and visible web
result, then remove obsolete daemon public port/webhook configuration.

`POST /api/transcriber/completed` remains a compatibility import endpoint for an
older daemon during rollout. It authenticates the old shared secret and cannot
overwrite primary-owned recordings. New capture and transcription never call it.
`transcriber_notifications` is retained only as historical migration state.
