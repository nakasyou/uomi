# Uomi

A local-first Omi client with direct Notion storage and a Bun transcription daemon.
English UI, Material 3, React Native on Android and React Native Web in Tauri on Linux.
No Workers, D1, Queues, R2, S3 or hosted application server is required.

## Workspace

```text
apps/client          Android + Linux client, Bluetooth, local SQLite, playback and UI
apps/transcriber     TypeScript/Bun webhook daemon with ffmpeg and nTranscribe
packages/audio       Lossless Opus packet, Ogg and synthetic-gap helpers
packages/notion      Shared Notion schema, uploads, manifests and transcript storage
```

Bun workspaces use a hoisted dependency layout for React Native's native tooling.
Vite+ owns development, web builds, formatting, linting and daemon bundling.

```sh
bun install --frozen-lockfile
bun run dev             # Browser UI preview; native Bluetooth/storage require the app
bun run linux           # Tauri client; Linux native dependencies are provided by nix develop
bun run android         # Android device/emulator, JDK 21 and Android SDK required
bun run android:release # Requires your own signing configuration
bun run check           # Format/lint, type checks, tests and both application builds
nix develop --command bun run linux:check
```

Android SDK/NDK versions are in `apps/client/android/build.gradle`. Set
`apps/client/android/local.properties` or ANDROID_HOME locally. Package identifiers,
the Linux data directory `~/.local/share/me.uomi.client`, and existing recording
identities are retained. Native storage adds a versioned binary audio table. Legacy
JSON recordings migrate transactionally while the app is foreground and idle;
encoded Opus packets are preserved without transcoding. See [local storage](docs/local-storage.md). Previous webhook acknowledgements do not count as Notion uploads.

## Connect Notion

1. Create a dedicated Uomi database with a title property.
2. Create an internal Notion connection with Read, Insert and Update content.
   Share only that database with the connection. Child pages inherit access.
3. In Settings, enter the database/data source ID or URL and the connection token.
   A database with multiple data sources requires the specific data source ID.
4. Save settings. Uomi adds the properties below on the next sync or refresh.
5. Pair Omi in **Devices**, press **Import from Omi**, then **Sync to Notion**.

The token is stored separately from legacy webhook credentials, using the Linux
Secret Service keyring or Android Keystore-encrypted local storage. Native HTTP
calls contact Notion directly; no Notion token is sent to the transcriber webhook.
The browser build is a UI preview and deliberately does not collect or upload live
Notion credentials. Use the Android/Tauri app for real sync.

Notion properties: Name, Recording ID, Device, Recorded at, Duration (s), Status,
Audio, Manifest, Transcript, Transcript preview and Error. Status moves through
Uploading → Pending → Processing → Completed, or Failed. A dedicated database
avoids conflicting property names/types. API version is pinned to 2025-09-03.

Audio attachments are Ogg Opus: original encoded frames are muxed without lossy
re-encoding, gain adjustment or VAD filtering. Nearby recordings may include
explicitly marked generated silence; original packets remain unchanged. The JSON manifest retains
frame IDs, per-packet timestamps, sequence/ring identities and the audio SHA-256.
The daemon verifies this hash before processing. Device timestamps are not
sample-accurate; playback duration and wall-clock span can differ.

File sizes are checked against the connected workspace's actual API limit.
Files over 20 MiB use Notion multipart uploads. If the workspace limit is exceeded,
choose shorter chunks; local recordings remain available. Files are acknowledged
only after both audio and manifest are attached to the page.

## Transcriber daemon

Install Bun and ffmpeg on the processing machine. The daemon uses the requested
[nTranscribe](https://github.com/nakasyou/ntransctibe) library, pinned at
`7b15b53b216163dcb2c49556c99f9b7716b0baad` through a `github:` dependency in
`apps/transcriber/package.json`. Bun downloads it during installation; no upstream
source copy is kept in this workspace. The checked-in Bun patch changes only the
package export to `src/index.ts`, because upstream does not commit the `dist`
files referenced by its package metadata. Bun and Vite+ compile that TypeScript
source directly. Keep the patch and lockfile in sync when updating the revision.

Copy `apps/transcriber/.env.example` to `apps/transcriber/.env`, fill in your own
credentials and restrict that file's permissions. The daemon can use a separate
Notion internal connection shared with the same database.

```sh
bun run transcriber --help
bun run transcriber
# Explicit recovery after downtime, including interrupted or failed jobs:
bun run transcriber --recover
```

The default provider is `codex`, which reads the machine's existing Codex login.
Set `TRANSCRIBER_PROVIDER=chrome-recognition` to select nTranscribe's Chrome
provider instead. Both use upstream internal services, whose availability is not
guaranteed. Provider credentials remain on the processing machine.

The daemon binds to 127.0.0.1:8787 by default. Expose it through your own HTTPS
reverse proxy or authenticated network path, then configure the client's
Transcriber HTTPS URL as `https://your-host/webhook` and the matching secret.
Expose both `/reserve` and `/webhook` through the same HTTPS endpoint. `/reserve`
accepts recording metadata and source frame IDs (up to 8 MiB), never audio bytes.
`POST /webhook` accepts only `{ "pageId": "..." }` with
`Authorization: Bearer <UOMI_WEBHOOK_SECRET>`. The secret must be at least 24
characters. `/health` exposes only an availability response.

The daemon validates that the page belongs to the configured data source and that
audio attachments exist before responding 202. It processes requests serially,
converts only temporary working copies with ffmpeg, splits provider requests to
approximately 10 minutes and waits at least 10 seconds between requests. A 429
honors Retry-After (or applies a conservative fallback). Each completed chunk is
checkpointed locally before continuing, so retrying a failed result save can reuse
its transcript. Full text is attached as JSON; the bounded Notion preview is shown
in Library. Use **Read transcript** for the complete text.

There is no cloud queue. Notion is the durable pending-job record. The daemon
automatically recovers Pending/Processing and due Failed jobs at startup and every
minute, with at most 32 jobs admitted. Failed jobs retry with a persisted delay.
Notification failure does not lose the job. A stale lock is removed at startup
only when its owner PID is confirmed gone. Run one daemon per Notion database.
The state directory defaults to `~/.local/share/uomi-transcriber`.

For a macOS service, run `bun /absolute/path/to/uomi/apps/transcriber/src/index.ts`
under launchd with WorkingDirectory set to `apps/transcriber`, explicit Bun/ffmpeg
PATH and the required environment. Do not place tokens in a committed plist.
Service deployment is separate from building this workspace.

## Library and retention

Devices has separate **Import from Omi** (local capture only) and **Sync to Notion** (upload local audio and refresh transcripts, without connecting to Omi) actions. Automatic modes still run both stages. The last import and last Notion sync are tracked separately.

Devices owns Bluetooth pairing, sync progress, microphone gain and debug live
monitoring. Library shows local playback, Notion save/processing status, transcript
previews/full text, search and Notion links. Refresh transcripts explicitly to fetch
changes; manual mode does not run a background transcript poll. Search currently
covers cached previews; complete text is loaded on demand.

Manual mode is the default. Real-time mode uses ongoing native background work;
periodic mode uses OS-scheduled Wi-Fi-only jobs. By default, local originals are
removed only after reading back the Notion Manifest and verifying the saved audio
SHA-256. Cross-client reconciliation also compares original Opus packets and
timing before removal. Failure retains originals. Disable **Remove verified local
audio** in Settings to keep local copies. Explicit deletion remains available;
it never deletes Notion attachments. Temporary
decoded daemon audio is cleaned up after each attempt; original attachments remain.

Stable frame IDs allow a client to reconcile audio uploaded by another client,
including different chunk boundaries. The single daemon serializes page
reservations and keeps a local SQLite coordination index with unique source-frame
claims. A conflicting overlapping upload waits for the original chunk to finish
or resume. Ambiguous page-creation outcomes are journaled and never blindly
reissued; unresolved outcomes require checking Notion. The client and daemon must
both be updated to use coordination. The transcriber endpoint is optional: without it,
the client uploads directly to Notion and resumes from local checkpoints. Concurrent
clients without coordination may create duplicate pages.
Changing the Notion destination does not claim old uploads as saved to the new one.

The local library uses a compact SQLite packet index; audio payloads are loaded
only for playback and admitted upload jobs. Notion changes sync by server edit
timestamps with overlap. Unchanged manifests are cached, page status comes from
query results, and remote history is paged in groups of 50. Capped Notion queries
are partitioned by creation time instead of silently stopping at 10,000 results.

Preparing, audio upload, metadata upload and attachment each have two slots;
at most eight chunks are admitted. Ogg and catalog planning use Web Workers on
Linux; Android uses native audio workers and cooperative catalog planning. Nearby
recordings are combined only if the entire next run plus its silent gap fits the
configured maximum. Source Opus bytes are preserved; generated silence and source
timing are described separately in the manifest.

## Hardware and verification

Omi ring-storage firmware 3.0.20+ recording Opus is supported. Stock firmware
reclaims transferred device storage; Uomi keeps the imported local copy. Serial
metadata is optional; a normalized Bluetooth address is the fallback identity.
There is no firmware or application updater. See `docs/verification.md` for the
checks performed and the limits of physical-device/live-service verification.
