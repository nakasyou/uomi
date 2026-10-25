# Uomi web app

Void / React library with a private Sites API and MCP. R2 holds original Ogg audio
and compressed manifests; D1 holds primary metadata, full transcripts, search,
source identity claims, optional backup checkpoints, and durable transcription jobs.
Notion is an optional backup/import integration.

## Persistence

1. The client POSTs original Ogg plus source/timing manifest to `/api/chunks` with
   the recording ID as `Idempotency-Key`. The Worker validates identity and SHA-256.
2. Original bytes and the manifest are written to R2. A D1 transaction commits the
   recording, exclusive source interval claims, and standard transcription job.
3. HTTP 201 with `saved:true` confirms primary persistence. Duplicate submissions
   return HTTP 200; Notion confirmation is informational and never gates receipts.
4. Local audio remains until the user explicitly clears confirmed recordings.
   Partial overlaps and changed source bytes fail without deleting audio.
5. API workers claim jobs, renew leases and commit transcripts. The API transaction
   checks the lease token before saving text and completion. Stale results get 409.
6. Optional Notion backup advances independently with a D1 lease, checkpoints,
   persistent error/attempt state and exponential backoff. Ingest/status activity
   and daemon claims resume due work. Backup failures do not change primary-save
   or transcription results.

## Authentication

Data routes accept a Sites-authenticated owner identity or a revocable device key
in `X-Uomi-Secret`. Private Site service access additionally needs
`OAI-Sites-Authorization: Bearer <token>`. Device key creation/revocation requires the owner. Detailed-job requests and
MCP tools also accept a non-revoked device key in `X-Uomi-Secret`. A dedicated `UOMI_WORKER_SECRET` (legacy fallback
`UOMI_WEBHOOK_SECRET`) grants only job/audio/manifest transport and bounded historical
migration, not owner or capture privileges. Browser writes reject a different Origin. No provider tokens
are returned to browser code.

## API

- `POST /api/chunks`: binary `application/vnd.uomi.ogg` envelope, maximum 12 MiB.
  Legacy JSON uploads remain accepted. Receipt includes `id`, `sha256`, `saved`,
  informational `notion_saved`, and the standard `transcription` job.
- `POST /api/chunks/status` `{ids}`: up to 64 recording IDs. Each upload has
  `status:'saved'|'missing'`, separate `backup_status`/`backup_error`, and a
  `transcription` job. Backup failures never turn a persisted upload into failed.
- `GET /api/recordings`: newest-first cursor pagination; `q` searches normalized
  literal substrings; `from`/`to` filter overlapping recording intervals;
  `starred=1` filters stars. Rows include a standard-job summary.
- `GET /api/recordings/:id`: metadata, standard/detailed text and statuses,
  separate job objects, `segments`, `detailed_segments`, backup state and errors.
- `GET /api/recordings/:id/audio`: authenticated R2 stream with byte ranges.
- `GET /api/recordings/:id/manifest`: original source/timing manifest.
- `PATCH /api/recordings/:id` `{title?,starred?}`: immediate D1 edit; optional
  Notion update follows independently.
- `POST /api/recordings/:id/transcription`: enqueue/retry a failed standard job.
  Repeated requests do not duplicate work. Explicit `{retry:true}` requeues a
  completed/failed job and preserves the previous transcript until replacement.
  `/transcribe` remains an alias for older web clients.
- `POST /api/recordings/:id/detailed-transcription` `{retry?:boolean}`: durable
  Codex detailed job, authenticated by owner login or device key; no Notion dependency.
  Repeated calls reuse queued/active/completed jobs. `{retry:true}` reruns completed/failed
  jobs and preserves previous text until replacement. `GET` reads its persisted result.
- `GET /api/transcriptions?id=&mode=&status=&limit=&cursor=`: read transcription
  progress for one recording or the entire queue. `mode` is `standard`, `long`, or
  `detailed`; `status` is `queued`, `processing`, `retry`, `completed`, or `failed`.
  Returns `as_of`, filtered `summary` counts by mode/status, bounded `jobs` (default
  20, maximum 100), and `next_cursor`. Counts ignore pagination. Keep filters unchanged
  when following cursors. Jobs are ordered by last update descending; this is a live
  view, so ongoing jobs can move between pages. Poll the first page or a specific ID
  for live progress. `GET /api/recordings/:id/status` also returns all three jobs.
- `GET /api/jobs`: up to 100 recent durable jobs, including stage/progress,
  attempt, error, retry availability, lease expiry and last update time.
- `POST /api/jobs/claim`: atomically claim up to eight jobs using `worker_id`,
  `limit`, and `lease_seconds` (30–300). Returns same-origin audio/manifest URLs,
  mode, attempt, opaque lease token and lease expiry.
- `POST /api/jobs/:id/heartbeat`: renew token with optional stage/progress.
- `POST /api/jobs/:id/complete`: commit `text`, optional `segments` and `model`;
  same completed token is idempotent. Replaced/expired leases return 409.
- `POST /api/jobs/:id/fail`: persist actual `error`, `retryable` and optional
  `retry_after_seconds`; retry uses bounded exponential delay, maximum eight
  attempts. Manual retry starts a fresh attempt budget.
- `POST /api/recordings/:id/backup`: retry optional Notion backup. Unconfirmed page
  creation is searched by recording ID; absent pages remain explicitly unconfirmed.
- `GET/POST /api/migrations/notion`: worker/owner-only bounded import; POST
  `{reset:true}` once, then `{}` until `has_more:false`. GET returns persisted
  state, active lease expiry and the last import error. An unfinished cursor
  without an active lease is `paused`; `running` requires a live request lease.
- `POST /api/resync` `{reset?:boolean}`: migrate one historical Notion page
  per request; repeat while `has_more`. Reset starts a complete scan. Progress
  persists. `POST /api/recordings/:id/resync` imports one legacy page.
- `POST/GET /api/clients`, `DELETE /api/clients/:hash`: owner key management.

Unexpected failures return HTTP 500 with the actual bounded error, `code` and
`request_id`; structured Worker logs retain the stack. Input errors return 400,
missing resources 404, and stale job leases 409. Job/provider and backup errors
also remain in D1 for display after reload.

Segments use `{start_ms,end_ms,text,speaker?:string|null}` in the original
recording timeline. They preserve provider timing; plain-text providers return an
empty array. Search currently uses the standard transcript. Full result text and
both segment arrays are primary D1 data and are included in optional Notion backups.

## Transcription MCP and API examples

`POST /mcp` (Sites OAuth) and `POST /api/mcp` (device-key API alias) expose these tools (in addition to transcript search/read/index tools):

- `start_detailed_transcription({id,retry?})`: enqueue a detailed Codex job and return
  its durable state immediately. Active jobs are reused even with `retry:true`.
- `transcription_status({id?,mode?,status?,limit?,cursor?})`: same progress response
  as `GET /api/transcriptions`. Omit `id` for queue-wide counts and recent jobs.

Progress includes `stage`, `progress` (0–1), `detail` with segment/chunk counters
when reported by the worker (`detail.completed` / `detail.total`, plus
`detail.active` intervals with index/start/end/state), `attempt`, `max_attempts`, `error`, `available_at`,
`lease_until`, and `updated_at` (Unix milliseconds). Queued jobs may not have
segment counts yet. Lease expiry is diagnostic, not permission to claim or complete
another worker's job; no lease token is returned. A terminal `failed` job requires
manual retry; `retry` is scheduled automatically by the daemon. Starting work is
asynchronous and requires a running Codex daemon.

Use the existing Site service token and a revocable device API key; no provider
credentials are needed. These environment variables must be set privately:

```sh
# Start (returns HTTP 202 and detailed_transcription).
curl "$UOMI_API_URL/api/recordings/$RECORDING_ID/detailed-transcription" \
  -H "OAI-Sites-Authorization: Bearer $SITES_ACCESS_TOKEN" \
  -H "X-Uomi-Secret: $UOMI_CLIENT_SECRET" \
  -H 'Content-Type: application/json' -d '{}'

# Queue progress; append &id=<recording-id> to inspect just one recording.
curl "$UOMI_API_URL/api/transcriptions?mode=detailed&limit=20" \
  -H "OAI-Sites-Authorization: Bearer $SITES_ACCESS_TOKEN" \
  -H "X-Uomi-Secret: $UOMI_CLIENT_SECRET"
```

For an external script, send the same two headers to `POST /api/mcp` with
`Content-Type: application/json`. The canonical `/mcp` path is protected by Sites
OAuth before reaching the Worker; `OAI-Sites-Authorization` alone does not bypass
that MCP gateway. ChatGPT/Codex connections use the canonical OAuth endpoint.

Equivalent MCP `tools/call` bodies:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"start_detailed_transcription","arguments":{"id":"<recording-id>"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"transcription_status","arguments":{"mode":"detailed","limit":20}}}
```

Anonymous/revoked keys receive HTTP 401; worker transport keys cannot invoke MCP
or the capture/control API (HTTP 403). Cross-origin authenticated browser writes
are rejected. Invalid arguments use HTTP 400 or MCP `isError:true`; missing recording
IDs use 404 (`structuredContent.status` for MCP). Results and progress are stored
in D1, independently of optional Notion backup.

## Migration and backup

Keep existing `0000`–`0003` migrations unchanged. Apply
`0004_detailed_transcription.sql`, `0005_jobs.sql`, then
`0006_query_performance.sql`, then `0007_notion_cutover.sql` before publishing. The query-performance migration adds virtual sort keys and
indexes verified with realistic query plans; see [query performance](../../docs/query-performance.md). Existing
recording IDs, audio keys and transcripts survive. Existing audio-bearing pending
recordings receive durable standard jobs. Existing cached audio becomes primary.

Historical import downloads/validates audio and manifests before committing,
imports standard/detailed transcripts and preserves original IDs and source timing.
Missing original Audio/Manifest attachments are reported as `warning:missing_audio`
with `audio_imported:false`; metadata import can continue so incomplete sources
can be enumerated. When a previously missing source finishes uploading, per-record
import can hydrate verified audio/manifest/source claims without replacing primary
title, transcripts, segments, statuses or revision, even after primary edits. A
concurrent hydration winner or source-claim conflict cannot overwrite existing
audio; claims and file references change transactionally. It scans active/archived pages with resumable cursors and splits capped queries
by creation windows. A failed download does not advance the cursor. The cutover migration permits one refresh of untouched historical Notion snapshots
(`notion_edited` present, revision zero, import version zero), then records import
version one and an already-backed-up revision. Background backup never writes
untouched Notion snapshots back into their source. New uploads and primary edits
are protected throughout, including concurrent edits during source downloads.
Once imported, a recording is primary-owned: later imports and archived backups cannot overwrite
its edits/results or delete it. D1/R2 must be retained and backed up as primary data.
Legacy completion callbacks remain for a staged migration but do not overwrite
primary-owned recordings; no normal capture/transcription path sends webhooks.

Configure `DB`, `BUCKET` and `SITES_ACCESS_TOKEN`. Optional Notion settings are
`NOTION_TOKEN` and `NOTION_DATA_SOURCE_ID`; Notion needs Read/Insert/Update access
only for backup/import. A daemon uses a web-issued `UOMI_CLIENT_SECRET` and the
private Site service token. See [worker protocol](../../docs/webhook.md).

## Development and storage format

Run `bun run dev`, `bun run build:viewer`, `bun run test:web` and
`bun run typecheck` from the repository root. `.dev.ts` routes supply explicit
visual samples and are excluded from production. `scripts/package-build.mjs`
adapts Void output into Sites' Worker/client contract; SQL stays in `drizzle/`.

`recordings.rid` is the stable integer primary key; public `id` values do not
change. Source claims and FTS use integer IDs. Original text stays intact for
reading; search text is NFKC/lowercase/kana/whitespace normalized. Two-code-point
queries use escaped LIKE; longer queries intersect compact trigrams and verify
exact substring order. Legacy normalization/manifests migrate in bounded batches
through search/index-status, with explicit readiness errors rather than lost rows.
New manifests are gzip-compressed range runs in content-addressed R2 objects.
