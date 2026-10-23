# Notion storage contract

Each audio chunk is a Notion page in the configured data source. The Audio and
Manifest files must both be attached before the page is Pending and the client
marks its original local frames uploaded. The manifest's `sha256` hashes the Ogg
file, `frameIds` retain stable source identities, and `timing` maps groups of frames
to device packet timestamps. Generated silence is identified separately in `gaps`.

A local reservation stores the page ID before byte upload, so interrupted uploads
resume that page. Unknown page-creation outcomes are reconciled by Recording ID on
the next sync; writes are not blindly retried. Notion lacks atomic unique keys, so the single daemon now coordinates persistent
source-frame reservations before page creation. Remote manifests allow
frame-level deduplication when reconciling uploads with different chunk sizes.

Notion's expiring download URLs are always retrieved just before use. The webhook
contains a page ID only. The daemon has its own configured Notion connection and
validates the page's parent data source before fetching attachments. Completed
pages ignore repeated webhook delivery. Audio and manifest hashes must agree.

Notion files have no independent delete capability restriction. This app's
retention policy is enforced by its own behavior, not by a promise that the token
cannot modify or archive content. Limit each connection to the dedicated database.
No tokens or signed attachment URLs are included in public errors or daemon logs.

`Recorded at` stores the recording start as an ISO timestamp, including seconds
and fractional seconds. `record_finished_at` is a date property computed as that
start plus `Duration (s)`; it describes the audio timeline, not transcription
completion. Unknown start times leave it empty. New recordings set it on page
creation; refreshing Notion fills missing values on existing recordings without
replacing an existing end date or changing audio attachments. Device timestamps
have seconds precision; fractional times come from the audio frame timeline.

`recorded_at_ms` and `record_finished_at_ms` store the same start/end instants as
integer Unix epoch milliseconds (UTC). Unknown times stay empty rather than zero.
Notion refresh also fills missing numeric values on existing rows, preserving
populated values. These columns retain timestamp values; they do not increase
the device clock's original precision.

The client reports Notion sync by phase: local loading, remote recording and
manifest checks, audio upload, manifest upload, file attachment, and transcript
status refresh. Preparation shows counts as they become known; it does not
invent a percentage for unknown totals. Upload progress counts frames and chunks
only after both audio and manifest are attached. It is durable-save progress,
not a byte-level network transfer percentage.

## Verified local removal

The default now removes local originals only after Notion read-back verification.
The returned page must be available, its Manifest must match the prepared ID,
source frames, timing, gaps, duration and SHA-256, and the actual Audio file must
hash to that SHA-256. Existing remote copies are also compared packet-for-packet
and against the original packet timing before their local originals are removed.
Any mismatch, unavailable file or interrupted verification leaves originals.
Tombstones and removal are committed together in SQLite; partial source packets
are retained until all their frames are verified. The setting can retain copies.

Library can fetch and verify an individual Notion audio file for playback after
its local copy has been removed. No original is deleted to make room for a queue.

## Incremental mirror and bounded loading

Packet metadata is indexed separately in SQLite. Legacy rows migrate lazily in
256-row batches without altering encoded source frames. The UI receives prepared
chunk plans; only admitted chunks load original audio. Local acknowledgement and
removal are batched transactions instead of one IPC/write per packet.

Notion pages are mirrored by server `last_edited_time`, with a two-minute overlap
and a watermark that advances only after successful persistence. Archived rows
are removed from the mirror. Remote pages are indexed by destination, device and
recording time. UI loads 50 rows at a time; search runs against cached metadata on
the native storage thread. Unchanged manifests are reused by attachment identity.
The client does not issue one additional status GET per row.

Queries that report `request_status.type=incomplete` are split into disjoint
creation-time windows. An indivisible capped window fails explicitly; it cannot
be reported as a complete sync. All native Notion API calls go through request
pacing; explicit 429 rejections respect Retry-After and retry. Unknown creation
outcomes are not retried blindly. Notion's service rate limits still apply.

## Bounded upload pipeline and restart recovery

Chunks pass through Preparing → Uploading audio → Uploading audio metadata →
Attaching files to Notion → Verifying saved audio → Notifying transcriber in that order. Different chunks overlap across stages;
attachment, verification and daemon notification have independent two-slot stages,
and at most eight jobs are admitted at once. UI shows
active/queued/completed counts and a progress bar for each stage, plus overall
durably saved frame progress. Stage bars cover jobs admitted to that stage, not
bytes sent. Notion request starts remain spaced by 400 ms; request completion
does not serialize independent stages.

Linux uses up to two module Web Workers for Ogg generation, including playback.
Ogg bytes transfer back without a second structured clone. Android uses two native
audio worker threads and a separate bounded network executor; audio processing
and network calls no longer share the BLE/storage executor. Neither path
re-encodes Opus.

Before file upload, `notion:job:<target>:<id>` stores the page ID and original
manifest locally. Each successful file upload adds its upload ID to that
checkpoint. On the next sync, unfinished jobs retain their original boundaries
even if chunk length changed. Uploaded file IDs are checked through Notion's
[retrieve file upload API](https://developers.notion.com/reference/retrieve-file-upload).
Valid uploads are reused; expired or missing uploads are sent again into the same
page. Existing Audio/Manifest attachments are preserved. Uploads interrupted
before a file completed restart that file; byte-level multipart resume is not
claimed. Legacy Uploading pages without local checkpoints are matched by stable
Recording ID when regenerating the same chunk boundaries.

A fully attached Uploading page can advance to Pending and notify the daemon.
If original local frames required by an unfinished job are missing, sync reports
an error instead of discarding the page or inventing audio. Local acknowledgement
commits are serialized because attachments may finish out of order. Each packet
only acknowledges its contiguous saved prefix; queue errors drain started work
before reporting failure. Checkpoint cleanup never deletes original recordings.

## One-daemon coordination

The transcriber endpoint is optional. Without it, native clients upload directly
to Notion using local reservation/checkpoint recovery and remote frame reconciliation.
Simultaneous uncoordinated clients can create duplicate pages. When configured,
clients use the same daemon for `/reserve`.
It receives source identities and metadata, not audio. A local SQLite coordination
index serializes reservations and claims each source frame uniquely. Clients with
overlapping chunk boundaries must wait for the original reservation to finish or
resume that chunk. The journal is committed before page creation, so a lost
response cannot silently cause a second create. A retry searches Notion for the
original page; an unresolved outcome stays blocked for review.

The daemon processes one transcription at a time and recovers due Notion jobs at
startup and every minute, with a bounded in-memory queue of 32. Failed jobs persist
Attempts and Retry after with exponential delays. Pending duplicate pages left by
older clients are archived only after identical canonical audio is verified and
its transcription is completed; completed transcript alternatives are preserved.

Both client and daemon need this protocol version. Expose authenticated `/reserve`
and `/webhook` on the same HTTPS base path. A valid old upload checkpoint resumes
its exact source boundaries even after the maximum chunk length changes.

Artificial silence is recorded in `Manifest.gaps` with source-frame boundary, duration, and offset in the merged audio. Notion also receives `Synthetic silence (s)`, `Synthetic silence count`, and `Synthetic silence intervals`. The intervals preview contains relative millisecond offsets and absolute start/end timestamps when the recording clock is known. Large previews explicitly indicate truncation; the Manifest retains every interval. Legacy manifests without offsets do not invent timestamps. Transcription removes only these generated packets from temporary input, retaining original encoded source packets; the stored Notion audio remains unchanged.

Reconciliation checks at most two pages concurrently and drains started checks
before reporting a failure. Candidate pages are selected per device and per merged
recording-time window, including the maximum 15-minute page overlap. Devices with
unknown local recording clocks retain an unbounded query. Repeated candidate pages
are checked once per sync. Local deletion still requires successful read-back
verification. Library metadata is read in batches. Source schema metadata and
concurrent upload-limit lookups are reused; daemon reservations perform one
Recording ID reconciliation before their durably journaled page creation.
