# Uomi

Capture original Omi audio, search recordings, and follow transcription in a private web app.
**Cloudflare R2 stores original audio and manifests; D1 stores recordings, transcripts,
search indexes, and durable jobs. Notion is an optional backup and historical import source.**
Original Opus packets are preserved without lossy re-encoding.

| Workspace          | Role                                                                   |
| ------------------ | ---------------------------------------------------------------------- |
| `apps/client`      | Android / Tauri Linux capture, offline queue, verified uploads         |
| `apps/web`         | Recording library, authenticated upload/job API, search, playback, MCP |
| `apps/transcriber` | Bun + ffmpeg API polling worker with bounded parallel transcription    |
| `packages/audio`   | Lossless Ogg/Opus and source timing utilities                          |
| `packages/notion`  | Optional backup and historical import format                           |

## Capture and upload

In the private [web app](https://uomi-transcript-search.nakasyou.chatgpt.site),
open device settings and create a named key. Copy its upload URL, API key and
Sites service token to the capture client. Native secrets use Android Keystore
or Linux Secret Service. Keep the Site owner-private.

Import Omi recordings locally, then upload them. Import works offline; uploading
saved recordings needs no BLE connection. Manual, periodic and real-time capture
use the same durable local queue.

A successful `saved:true` response confirms original audio in R2 and recording,
source claims and transcription job in D1. Notion availability has no effect on
that confirmation. Retries are idempotent. The client keeps original audio until
the user explicitly clears confirmed copies; it never deletes audio automatically.
Conflicting source identities and partially overlapping chunks fail with details.

## Recordings and transcription

The web app provides date-grouped recordings, search, date filters, stars,
editable titles, playback, waveforms, speed and seek controls, and separate standard
and detailed transcripts. Active jobs expose stage, progress, attempts and errors.
Title/star edits and transcript results commit to D1 before optional backup work.

The transcriber claims durable jobs from the API, renews expiring leases, downloads
original audio and manifests, verifies checksums and stores its result through the
API. Expired/replaced leases cannot overwrite a newer result. Retry state survives
worker restarts. Standard transcription uses the configured nTranscribe provider;
detailed transcription uses Codex. Provider credentials remain on the daemon host.
Results can include recording-relative segment times and speaker IDs when the
provider supplies them; timing is never fabricated from plain text.

Copy `apps/transcriber/.env.example` to an untracked `.env`. Configure `SITES_URL`,
`SITES_ACCESS_TOKEN`, and `UOMI_CLIENT_SECRET` (a web-issued key or a dedicated
worker secret configured as `UOMI_WORKER_SECRET` in Sites). Install ffmpeg and the
selected provider's dependencies/authentication, then run `bun run transcriber`.
No public daemon port, webhook URL, or Notion credential is needed for transcription.
See [transport and worker protocol](docs/webhook.md).

## Notion backup and migration

Configure optional `NOTION_TOKEN` and `NOTION_DATA_SOURCE_ID` only in Sites secrets.
Backups resume from D1 checkpoints, retry with backoff, and report errors separately
from primary saves. An uncertain page creation first searches for the existing
recording before proceeding; it never blocks primary playback, edits or transcription.

Use the web app's Notion import to migrate existing history, repeating bounded
requests until `has_more:false`. Audio hashes and manifests are verified before
committing each recording. Cursors persist across restarts. Repeating an import
cannot overwrite primary recordings or delete them when their Notion backup is
archived. Keep D1 and R2: they are primary storage, not disposable caches.

## Development

```sh
bun install --frozen-lockfile
bun run dev
bun run dev:client
bun run linux
bun run android
bun run build:viewer
bun run typecheck
bun run test
bun run transcriber
```

Sites provisions `DB` and `BUCKET`, keeps the existing private Site/plugin identity,
and applies the immutable SQL migrations in `apps/web/drizzle`. Apply through
`0006_query_performance.sql` before serving the new API. See the
[query-plan evidence](docs/query-performance.md). Existing audio-bearing pending records
receive standard transcription jobs in that migration; public recording IDs and
original audio remain unchanged. See [web API and operations](apps/web/README.md).
Native Bluetooth and background capture still require hardware verification.

## License

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md).
