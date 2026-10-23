# Uomi Web Recorder

Void 1.2 / React viewer + private Sites MCP. Single owner, multiple capture devices.
**Notion is canonical.** D1 stores rebuildable metadata, original/normalized transcripts and compact FTS; R2 stores
rebuildable audio and compact manifest copies plus staged uploads waiting for Notion.

## Flow

1. Capture client stores original Omi packets locally, groups bounded chunks and
   POSTs one `uomi.audio.v1` chunk to `/api/chunks` with an idempotency key.
2. Worker validates Opus packets and identity, muxes original bytes to Ogg, stores
   R2 audio/manifest objects and a transactional D1 row/source interval claims. A 202 receipt means
   staged only, **not** saved in Notion. The client retains local audio.
3. `waitUntil` advances Notion save checkpoints: page → audio → manifest → attach
   → readback/hash verification → transcript → done. A durable D1 lease and
   checkpoints permit resumption after the 30-second background budget.
4. Reposting the same chunk advances outstanding work without duplicating it;
   only a confirmed canonical save returns `notion_saved:true`. Manual clearing
   on the client is permitted only after this acknowledgement. Automatic local
   deletion is disabled. A hash mismatch or partially overlapping chunk
   fails visibly rather than claiming success or deleting source audio.
5. The existing transcriber daemon processes Notion Pending pages. Resync imports
   its resulting transcripts into D1. There is no server transcription model.

Notion page-creation timeouts are explicitly `uncertain`, not blindly retried.
The retry endpoint first searches for the existing recording ID. If absent, the
owner must resolve the Notion outcome rather than risk creating duplicate pages.

## API

All data routes require Sites visitor identity, or a revocable device key via
`X-Uomi-Secret` plus Sites' private service access header. No multi-tenant schema.

- `POST /api/chunks`: max 12 MiB JSON, 900 seconds/45,000 Opus packets, 1,500 ranges.
- `GET /api/recordings`: bounded newest-first cursor pages, `q` literal substring
  (minimum 2 characters after normalization), `from`/`to` overlap filters and `starred=1`.
- `GET /api/recordings/:id`: cached metadata and full transcript.
- `GET /api/recordings/:id/audio`: authenticated R2 streaming with byte ranges.
- `PATCH /api/recordings/:id`: write title/star to Notion, then update cache.
- `POST /api/recordings/:id/backup`: resume a pending Notion save.
- `POST /api/recordings/:id/resync`: reread that canonical page and audio/transcript.
- `POST /api/resync` `{reset?:boolean}`: import one changed Notion page per call;
  repeat while `has_more`. Reset starts an exhaustive reread without destroying
  staged uploads. Progress persists between calls. Source files capped at 20 MiB
  per audio, 6 MiB manifest and 1 MiB transcript; failed reads do not checkpoint.
- `POST/GET /api/clients`, `DELETE /api/clients/:hash`: owner-only key management.

Downloads/search need no live Notion calls once cached. Source resync takes the
slower upstream path and uses canonical page IDs, attachment hash validation,
transactional replacement and a watermark overlap. Bulk resync scans both active and archived pages and removes cached archived
records. Capped queries are split by creation-time windows, with persistent cursors
and an explicit error for an unsplittable timestamp. Individual resync is also
available to invalidate one canonical page. Existing
Notion history can be recached without re-uploading or changing the originals.

## Configuration

Reuse `.openai/hosting.json` Site identity. Bind D1 as `DB` and R2 as `BUCKET`.
Set `NOTION_TOKEN` (Read/Insert/Update, dedicated Uomi source),
`NOTION_DATA_SOURCE_ID` (actual UUID), and `SITES_ACCESS_TOKEN` (the same private
Site's service token) in Sites secrets. The last is returned only to the owner
when issuing a device key; no secret is built into JS bundles. A Site sharing
policy must remain owner-private. Native client keys use Keystore/Secret Service.

## Development

From the repo root: `bun install`, `bun run dev`, `bun run build:viewer`,
`bun run test:web`. Void supplies file-based server routes and Workers builds.
`.dev.ts` routes contain labeled visual QA samples and are excluded from builds.
Production uses the actual D1/R2 bindings. `scripts/package-build.mjs` adapts Void's
`dist/ssr` Worker output into Sites' `dist/server` contract. SQL stays in `drizzle/`
for Sites-managed immutable migrations; Void deployment provisioning is not used.

The Sites source mirror contains the monorepo so workspace packages resolve. It
builds `apps/web` and packages its Worker/client assets plus the same migrations.
The GitHub PR does not auto-deploy. Android/BLE and Linux native behavior still
need hardware verification; JS protocol, storage and acknowledgement flows have
automated tests.

## Storage/search format v2

`recordings.rid` is a stable INTEGER PRIMARY KEY; public `id` and Notion page IDs
remain unchanged. Source interval foreign keys and FTS doc IDs use `rid`. The
source range table uses WITHOUT ROWID. The old unused sync_state is removed.

Original text is retained for display and UTF-16 offsets. Search text is NFKC,
lowercase, katakana-to-hiragana folded, NFC, with Unicode whitespace/zero-width
spaces removed. This does not equate phonetic spellings with English names.
Two-code-point queries use escaped LIKE on normalized text, constrained by dates
when supplied. Longer queries intersect unique trigrams in external-content FTS5
with detail=none/columnsize=0 and verify substring order/multiplicity with instr.
FTS no longer stores a second text/UUID copy or token positions.

New manifests are gzip-compressed range runs in content-addressed R2 objects;
Notion's canonical v1 manifest is unchanged. D1 stores their keys and source claims.
Legacy D1 blobs and text normalization migrate in bounded restart-safe batches
through index_status or search (100 records and one manifest per invocation).
Public search is explicit about incomplete migration instead of dropping rows.
Clear a legacy blob only after an R2 readback/hash check succeeds. Deleted objects
can be restored through Notion resync. Freed SQLite pages may remain allocated
for reuse; a smaller payload does not imply an immediately smaller database file.
