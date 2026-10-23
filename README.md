# Uomi

An Omi capture client and private web recorder. **Notion is the source of truth**;
Cloudflare D1 and R2 are persistent caches for fast search, text and audio delivery.
Original Opus packets are preserved without lossy re-encoding.

| Workspace | Role |
| --- | --- |
| `apps/client` | Thin Android / Tauri Linux client: BLE import, local durable queue, chunk sync |
| `apps/web` | Void / React Material Recorder viewer, upload API, persistent caches, MCP |
| `apps/transcriber` | Bun + ffmpeg daemon: process Notion pending audio with nTranscribe |
| `packages/audio` | Lossless Ogg/Opus and source timing utilities |
| `packages/notion` | Canonical Notion schema, uploads, manifests, transcript storage |

## Capture and sync

Open the private [Web Recorder](https://uomi-transcript-search.nakasyou.chatgpt.site),
choose **Connect devices**, and create a named device key. Copy its upload URL,
API key and Sites access token into the capture client's Settings. The two secrets
are stored in Android Keystore / Linux Secret Service, separately from old Notion
credentials. Keep the Site private to the owner.

Pair Omi and choose **Import & sync**. **Import only** works offline; **Send saved
audio** needs no BLE connection. Manual is the default. Periodic mode uses native
Wi-Fi jobs; real-time mode uses native background activity. Local binary SQLite
storage and device cursors remain compatible with existing installations.

Each chunk takes one request. Sites durably stages original audio in R2 and
metadata in D1, then uses `waitUntil()` to advance the save to Notion. Staging is
not canonical-save confirmation: the client keeps audio and retries idempotently
until Notion save/readback is verified. Only acknowledged recordings can be
explicitly cleared locally. There is no automatic deletion. Different chunk
boundaries that overlap existing source frames fail visibly rather than claiming
save or discarding originals.

## Web Recorder

A Google Recorder-inspired Material layout provides date-grouped recordings,
full-text search, date filters, stars, editable titles, original-audio playback,
real decoded waveforms, speed/seek controls and transcript reading. There is no
native Library screen. Search and downloads use D1/R2 after the initial cache fill.
Time filters operate on recording intervals; source transcripts have no word times.

**Sync from Notion** imports changed pages. **Rebuild cache from Notion** rereads
history without deleting pending uploads. **Reload from Notion** refreshes a
selected page and audio, including invalidating a source page marked archived.
Notion-save retries are available per recording. See [Web API and operations](apps/web/README.md).

## Transcriber

The existing daemon remains a separate processing service. It reads audio and
manifests from Notion, verifies hashes, transcribes temporary ffmpeg copies and
writes the full transcript JSON back to Notion. After Notion save is verified, Sites notifies the daemon. A durable completion
outbox refreshes the D1 transcript from Notion automatically, with minute-level
retry across restarts. Source resync remains available as a repair path. No model or provider credentials run in Sites.

Copy `apps/transcriber/.env.example` to an untracked `.env`. Configure
`NOTION_TOKEN`, `NOTION_DATABASE_ID`, and `UOMI_WEBHOOK_SECRET` (24+ characters).
The Notion connection needs Read/Insert/Update access to the dedicated database.
Set `TRANSCRIBER_PROVIDER=codex` or `chrome-recognition` and install ffmpeg.
Run `bun run transcriber`; Pending/Processing/Failed jobs recover at startup and
periodically. The native client no longer needs the daemon webhook or Notion token.

## Development

```sh
bun install --frozen-lockfile
bun run dev                 # Web Recorder, Void development runtime
bun run dev:client          # Capture UI preview; native APIs require Android/Tauri
bun run linux
bun run android
bun run build:viewer
bun run typecheck
bun run test:web
bun run transcriber
```

Sites provisions `DB` and `BUCKET`; runtime Notion credentials and service access
stay in Sites secrets. Void builds the Worker and UI; the Sites publication flow
retains authentication, database migrations and the existing private plugin.
JavaScript checks do not replace physical Omi/Android/Linux verification.

## License

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md).

### Connect the transcriber to Sites

Sites runtime secrets: `TRANSCRIBER_WEBHOOK_URL` (public HTTPS `/webhook` endpoint)
and `UOMI_WEBHOOK_SECRET` (same 24+ character secret as the daemon). The daemon
needs `SITES_URL` (the private Site origin) and `SITES_ACCESS_TOKEN` (that Site's
service token). No secrets go in Git or browser bundles. Restart the daemon after
configuring it. Until configured, its Notion polling still works, but automatic
completion delivery is disabled and Sites index_status reports configured=false.

Sites journals notifications in D1, uses waitUntil after canonical persistence,
and retries due entries during API/index-status activity. Notion polling is the
independent fallback when Sites is idle or a webhook is lost. The daemon keeps
completion events on disk before committing Notion Completed, and retries every
recovery cycle. Failed callbacks never mark successful transcription as Failed.

`POST /api/transcriber/completed` authenticates both private Sites service access
and the shared webhook secret, then reads the canonical page/transcript and
commits normalized text/FTS. It returns saved=true only after D1 commits; duplicate
callbacks are safe. `POST /api/recordings/:id/transcribe` manually retries a daemon
notification. Existing backup retry also resumes notification after save.
