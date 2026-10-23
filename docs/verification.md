# Notion monorepo verification — 2026-10-22

Current implementation uses `apps/client`, `apps/transcriber`, and shared audio/Notion contracts. No live Notion credentials were supplied for this verification.

- `bun install --frozen-lockfile` passes with the hoisted monorepo layout.
- Scoped `vp check apps packages README.md PRODUCT.md docs` passes without lint warnings; strict TypeScript checks, 83 client tests and 19 shared audio/Notion/daemon tests, web build and daemon bundle pass.
- Manual sync now has independent **Import from Omi** and **Sync to Notion** actions. Tests verify import makes no Notion calls, Notion-only sync makes no Bluetooth calls even with a paired device, separate import/cloud timestamps, and empty-database initialization.
- New tests cover Notion attachment-before-ack ordering, failed attachment retention/resume, legacy webhook acknowledgement migration, offline transcriber notification, cross-client reconciliation with different chunk boundaries, full transcript retention beyond the preview limit, safe HTTP errors, webhook authorization, and ffmpeg-to-result-save processing with a fake Notion API/provider.
- Linux `nix develop --command cargo check --manifest-path apps/client/src-tauri/Cargo.toml` passes, including native credential isolation and Notion HTTP commands.
- Android `:app:compileDebugKotlin` and `:app:assembleDebug -PreactNativeArchitectures=x86_64` pass. Metro generates the new workspace's Android bundle successfully.
- The debug app installed and launched on a read-only API 35 x86_64 emulator. Library and Devices navigation were checked; the captured ReactNativeJS/AndroidRuntime error log window is empty. Screenshots: `screenshots/notion-android-library.png` and `screenshots/notion-android-devices.png`.
- Web Library, Devices and Settings were observed at desktop width; compact Settings was also observed. These are browser layout checks, not physical-device proof. No live Notion tokens were entered in the browser preview.
- Before verified-upload retention ran, original audio was checked read-only against the frozen snapshot: 183,943 records, no missing records and no changed audio content. SHA-256: `7fed664d938cc927b61c7035465122e283724852f5518159ee40265394d24e19`.

Upload pipeline verification (2026-10-22): per-stage concurrency never exceeds
two, stages overlap, admission stays within eight jobs, and failed runs drain
started work. Tests cover exact-boundary restart after changing chunk length,
valid/expired file-upload checkpoints, legacy partial attachments, metadata
failure without resending audio, fully attached Uploading recovery, and
out-of-order acknowledgement of frames in one packet.

Browser worker checks confirmed byte-for-byte identical Ogg output, at most two
workers for three concurrent 10-minute synthetic jobs, no remaining workers, and
34 UI heartbeat ticks during preparation. A JVM check of the Android Kotlin Ogg
implementation produced the same SHA-256 as TypeScript for 100 packets and
rejected empty/truncated input. Android Kotlin compilation and Linux cargo check
pass. The updated four-stage progress display was inspected at desktop width
with fixture data; these checks did not upload personal audio to Notion.

Outstanding live checks: scoped Notion connection against an actual database, Linux keyring/Android secure credential round trips with user tokens, real upload/download and notification over HTTPS, physical Omi Bluetooth/background behavior, and daemon deployment on Mac mini. nTranscribe's provider services are upstream internal endpoints; their continued availability is outside the application contract. Notion lacks atomic uniqueness/job claims: the updated single daemon coordinates persistent source-frame claims for current native clients. Direct legacy writers remain outside this coordination. One daemon per database is supported.

The following sections are historical checks from before the workspace/Notion migration. Their old paths and webhook behavior are not claims about the new Notion integration.

---

# Verification

Recorded on 2026-10-21. The shipping architecture is **React Native Android and React Native Web + Tauri Linux**.

## Automated checks

- TypeScript strict type check passes.
- 19 TypeScript protocol/integration tests pass: 64-bit ring counters, fragmented records, Opus durations, segment upper bounds, frame identity, uncertain timestamps, durable-before-cursor ordering, restart retry, disk-full handling, purge tombstones, mode/Wi-Fi gates, stock auto-reclaim import and local retention across sync/restart, locked keyring capture, and scheduler rollback.
- Three Python receiver tests pass: Gzip/Deflate/identity decoding, overlapping client deliveries, and transaction rollback on conflicting frame payloads.
- `nix develop --command cargo check --manifest-path src-tauri/Cargo.toml` passes for the Rust/Tauri backend.
- Android `:app:compileDebugKotlin` and `assembleDebug -PreactNativeArchitectures=x86_64,arm64-v8a` pass. The debug APK is in `android/app/build/outputs/apk/debug/app-debug.apk`.
- An Android production JavaScript bundle was generated successfully with Metro. The debug APK uses the Metro server during development.

## UI observations

- Android app installed and launched on an isolated API 35 x86_64 emulator. Library and Settings screens were observed with no ReactNativeJS or AndroidRuntime error in the captured log window. Screenshots were captured with ADB; browser renders are not presented as Android proof.
- React Native Web layout was inspected at desktop and compact widths, including mode and compression controls. The browser-only preview deliberately rejects device/storage operations.
- The Tauri Rust app built and launched under an isolated Xvfb display. Its webview completed the app-owned storage/settings initialization and reported `UOMI_TAURI_SMOKE_OK`. The rendered Library screen is captured in `screenshots/linux-tauri.png`.
- One Rust test passes for escaping executable paths in systemd unit files, including spaces, quotes, backslashes and percent expansion.
- Android dark-mode / enlarged-font validation remains incomplete; the attempted follow-up was interrupted by a disconnected Metro development session. The diagnostic is not presented as a successful UI check.

## Hardware and operational checks still needed

- No physical Omi is connected. Actual BLE negotiation, on-device packet capture and connected live persistence are unverified.
- Test with a device advertising custody contract v1 and capabilities 0x01 (app-ack reclaim) and 0x02 (live persistence). Also test stock builds without these capabilities: import must work without custody negotiation, and the connection must close after import to resume device recording. Stock BLE auto-reclaim precedes local persistence and cannot be made transactional by the client.
- Real hardware should verify long recordings, ring overwrite, interruption during BLE transfer, competing client reconnection, screen-off operation and OEM battery management.
- An actual HTTPS webhook delivery, Linux Secret Service unlock workflow, Android foreground-service lifecycle and OS-triggered periodic jobs have not been exercised end-to-end.
- The reference receiver tests verify frame-level deduplication. Your receiver must implement that contract before relying on exactly-once processing.

## Local playback

- Added Ogg Opus muxing tests for page headers, CRC, granule positions and end-of-stream; shared chunk tests cover device/ring isolation, sequence gaps, clock discontinuities, a 2-minute chunk, unchanged frame IDs and matching library/webhook boundaries. Playback now uses the entire displayed chunk rather than a fixed 60-second preview.
- Real libopus-encoded tone packets remuxed by the app decode successfully with FFmpeg. ffprobe identifies mono Opus and the expected 0.32-second duration (raw frames have no encoder pre-skip metadata).
- Android `:app:compileDebugKotlin` passed with the native MediaPlayer bridge. Web production build and TypeScript checks pass.
- Audible playback inside Tauri and on Android hardware has not yet been verified. Linux WebKit requires an available Ogg Opus media decoder.

## Shared recording chunks

- 32 TypeScript tests pass. Library and webhook use the same canonical frame grouping; partial retries only omit acknowledged frames within those boundaries.
- Settings displays minutes and stores the existing second-based value for compatibility. The existing maximum remains 15 minutes. Raw packet storage and explicit-only local deletion are unchanged.
- Type checking and production web build passed; the updated chunk UI has not been visually checked inside the physical-device session.

## Debug live monitoring

- 36 TypeScript tests pass, including BLE fragment reassembly, sequence wrap/loss and exclusive debug-monitor lifecycle (no storage writes or webhook calls).
- Web production build, TypeScript checks and Android Kotlin compilation pass.
- Linux uses bounded Web Audio decode/scheduling buffers; Android uses MediaCodec Opus → AudioTrack on a separate executor. Debug audio is never persisted.
- Actual Omi CV2 live output, audible continuity and end-to-end latency have not been tested on hardware. Stock firmware may stop offline recording while live streaming; the Device UI explains this behavior.

## Microphone gain

- 41 TypeScript tests pass, including levels 0–8, invalid input rejection, read-only behavior, unsupported firmware, write/readback mismatch and reuse of the live monitor connection.
- Type checking and the production web build pass. No platform bridge changes are required: the existing BLE read/write operations serve Android and Linux.
- Physical-device gain changes and their audible effect have not been verified. UI labels follow the upstream firmware gain map, with level 6 (+20 dB) as the explicit default action.

## Firmware-aligned timestamp grouping

- Timestamp boundaries now match the official ring client: any backwards device timestamp step, or a forward step greater than 60 seconds. Compare device timestamps directly rather than subtracting the preceding packet duration from a seconds-resolution timestamp.
- Forward steps over 2 seconds through 60 seconds are retained as per-chunk timestamp-gap metadata, not fragmentation triggers. No artificial silence is inserted and original frame timestamps remain unchanged for delivery.
- Read-only verification against the existing local library: 21,178 records / 102,629 frames / 2,052.58 seconds are preserved; 124 old rows become 79 chunks at the saved 30-second maximum. All frame IDs were verified unchanged. Eighty short timestamp gaps remain visible as metadata.
- 45 TypeScript tests, type checking and web production build pass. Stored recordings and device settings were not modified by this verification.

Latest scale checks: native catalog metadata avoids loading encoded audio into JS; a read-only 183,943-record catalog produces 65 ten-minute plans. Browser preparation/planning shares a two-Worker pool and stayed responsive (37 heartbeat ticks). Rust has three passing tests including transactional removal rollback. Generated-gap metadata is tested through Notion columns and Manifest attachment, including absolute timestamps and bounded previews; temporary transcription input strips generated packets without changing original packet bytes. All cloud integration tests use fakes; no real personal audio upload/delete was performed.

Optional transcriber regression checks: a native-capable client with no endpoint uploads directly, retains audio on failed attachment, resumes the same page, and makes no coordinator/notification call. A configured endpoint still reserves via the coordinator.

## Native import and binary storage — 2026-10-22

- Android and Linux receive bulk ring audio natively; audio notifications do not cross the React Native/WebView bridge. Imports request bounded 1,024-packet ranges and commit batches of 32 original packets plus the durable cursor in one FULL-sync transaction. Progress events are throttled.
- Nine Rust tests cover binary round trips, malformed/truncated data, byte-fragmented streams and incorrect ranges/DONE, transactional cursor-failure rollback, tombstone deduplication, metadata acknowledgements and legacy migration rollback. An explicit read-only source-snapshot run converted and compared 2,000 actual recordings: 2,908,385 original JSON bytes became 790,777 binary bytes plus 1,004,786 metadata bytes (excluding catalogs and SQLite overhead). No source database was modified.
- The Android helpers passed the standalone JVM contract in `apps/client/tests/native-audio-contract.kt`, using a Java Base64 shim for Android's otherwise stubbed utility and real org.json. Checks cover binary round trips, irregular offsets and frame identities, fragmented ring input, invalid DONE and unsigned 64-bit sequence identities.
- The client tests include bounded native ranges, cumulative progress, foreground cancellation and incomplete native completion. Android requests high connection priority during import and restores balanced priority afterward. Actual MTU/PHY callbacks are displayed; Linux uses BlueZ's MTU when available and otherwise labels the observed notification-size lower bound. Unavailable PHY/connection interval values are not invented.
- Desktop and compact browser layouts were inspected with synthetic import metrics, not real transfer measurements. Native protocol changes require rebuilding/restarting the native app, not just reloading its frontend. Physical Omi throughput, radio negotiation and power consumption still need hardware verification.

A later read-only audit found the original 183,943 live recording keys already replaced by 183,943 matching retention tombstones (none missing), with newer imports in the live library. The earlier whole-library unchanged check therefore no longer describes current retention state. Binary migration tests used the immutable snapshot instead of modifying the live database. No real import, cloud upload, deletion or app restart was triggered for this verification.

Final native checks: Linux debug executable builds successfully, Android x86_64 debug APK assembles successfully, and Metro bundles the updated Android frontend. The desktop/compact import-metrics previews show the new fields without overlap. These builds were not launched against personal audio or installed over the running client.

## Interrupted Notion sync and Linux credentials — 2026-10-22

- The running client's keyring lookup was checked read-only: the Notion credential was present. No credential values were logged, changed or sent to Notion during this diagnosis. The historical failing subprocess output was not captured, so its underlying keyring-service cause is not proven.
- The Linux backend now serializes keyring access and retains successful credential reads in a session-only memory cache. Ordinary Notion API calls reuse it. Explicit successful saves replace it, failed saves preserve it, and explicit clears invalidate it. Reads have a 10-second subprocess timeout, writes a 15-second timeout, and initial empty/error lookups retry three times. Unreliable reads are not reported as definitive missing credentials. No plaintext credential cache is written to disk.
- Five credential-cache regressions cover concurrent loads, transient empty/error recovery, failed/successful saves and clears, unreliable absence, and an explicit save racing an older read. All 14 Rust tests pass and the Linux executable builds.
- A failed explicit Notion sync drains started pipeline operations before releasing busy state, clears obsolete ETA/progress, and rebuilds the read-only catalog without blocking Retry/Settings. Refresh generations prevent an older rebuild from overwriting a newer retry. The regression test holds the failed run's catalog rebuild open while a retry completes successfully. All 83 client and 19 shared/daemon tests pass.
- The WebKit `NeedDebuggerBreak` line is emitted by JavaScriptCore's debugger-trap handler; that line alone is not a Notion HTTP error or evidence of a crash. See WebKit's `Source/JavaScriptCore/runtime/VMTraps.cpp`. No global JIT/debugger settings were changed.

The paused-error UI was inspected with fixture data at desktop and compact widths: Sync/Settings are usable, the obsolete ETA/pipeline display is absent, and retained device-transfer measurements are explicitly labelled Last Omi import. No live Notion sync was performed for this test.

## Notion reconciliation and planning progress — 2026-10-22

Reconciliation reports checked cached pages against a native SQL count, including manifest checks and saved-audio verification. Notion pagination reports fetched page counts while its total is unknown. Checkpoint discovery/restoration, local index loading, source-ID indexing, acknowledgement writes and chunk planning report their own work units. Planning reports sorting, merging (cooperative planner), continuity checks and generated chunk counts. Unknown totals display processed counts without a fabricated percentage or ETA.

All 86 client tests and 19 shared/daemon tests pass. The added regressions cover monotonic planner progress with unchanged chunk boundaries, progress text for known/unknown totals, and reconciliation/checkpoint restoration on retry. All 14 Rust tests pass; Linux debug build, Android Kotlin compilation, web build, typecheck and scoped format/lint checks pass. An actual browser Worker planned 3,000 synthetic recording indexes into the same five chunks as the synchronous planner while emitting loading/sorting/grouping/planning progress. Desktop and compact Devices previews display page counts, percentages and planned chunk counts without overlap. No personal audio, live Notion upload, deletion or app restart was used for verification. Native page-count support requires rebuilding/restarting the native client; older backends fall back to processed counts.

## Detailed transcription production release — 2026-10-23

The owner-private Sites deployment `appgdep_6adb648cfa748191b8df91154d329dd1`
succeeded using source commit `541bb8aca140ac807ec9029cfc55578ffda32c83`.
The deployed D1 history includes `0003_transcription.sql` and
`0004_detailed_transcription.sql`; these are now applied and immutable. Subsequent
migrations must follow that history rather than reuse index 4.

Mac mini builds Uomi revision `59c88798911d215f68c67ceff9ce1814e7455099`
from the `codex/detailed-transcription-release` branch. It includes the existing
canonical-completion gating fix and independent standard/detailed callback outboxes.
The pin and source hash are persisted in `~/dotfiles/pkgs/uomi-transcriber.nix`;
`result-uomi-detailed` retains the built nix-darwin closure. Sudo was unavailable,
so only the Nix-generated user LaunchAgent was installed/reloaded; a system-wide
switch was not performed. The daemon is running from the new Nix package, with
Chrome recognition and 900-second splits as the standard configuration.

Verified: production deployment success and detailed D1 columns; local daemon
health; webhook auth rejects unauthenticated requests and invalid detailed page
IDs; a synthetic spoken deployment sample transcribes successfully through the
actual Codex provider on Mac mini. No personal recording was used for the Codex
smoke test. The standalone browser requires ChatGPT sign-in, so owner-session
production UI interactions were not automated. The recording controls and state
transitions were exercised using labeled development fixtures before publishing.

## Primary storage and durable API migration — 2026-10-23

This release changes the storage contract: verified audio/manifests in R2 plus a
committed D1 recording/source transaction confirm a server save. Notion backup
runs independently; it cannot block acknowledgements, primary edits or API
transcription. Earlier deployed migrations 0000–0004 are preserved; 0005 adds
fenced transcription jobs, backup retries, primary ownership, segments and receipt
aliases. 0006 adds indexes for active work and bounded history queries.

Local verification includes full TypeScript checks, client/web/shared/daemon
regressions, Linux native tests/build, Android Kotlin compilation and APK build.
API worker integration uses the actual API with SQLite/R2 fixtures, real ffmpeg
decoding, worker authentication, progress and a saved transcript. Failure tests
cover lost completion responses, restart checkpoints, expired leases, SHA mismatch,
Notion outages, conflicting source ranges and migration replay preserving edits.

Web desktop/mobile checks cover layout, modal focus/Escape, HTTP diagnostics and
rename failure preserving user input. A simulated 503 displays operation, status,
server message and request ID. No horizontal overflow at 390px. The Impeccable
font warning is intentionally retained: Roboto is the pinned Material visual
reference. Client desktop/mobile fixtures pass its detector. Used client icons
are subset to 2.1KB instead of a 1.3MB font; client JS falls from 838KB to 651KB.

No Android device is attached to ADB, and the configured Omi was not visible to
Bluetooth during verification. Native app screenshot capture failed on offscreen
Wayland bounds. These checks do not prove a new physical-device import or a
real-device Android installation; the existing local audio was not deleted.

Client database optimization was measured read-only against 543,292 key/value
rows and 63,473 audio records. Prefix filtering changed from a covering-index scan
to a bounded primary-key search. Five alternating warmed samples gave medians
76.8→22.6ms for `record:` and 56.3→0.033ms for `cursor:` on this machine. These are
local measurements, not service latency guarantees. Joined/bounded reads remove
per-row audio lookups, and native receipt updates modify only metadata in a
transaction. A regression forbids audio BLOB INSERT/UPDATE/DELETE while verifying
acknowledgements, monotonic frame counts and rollback. Existing indexed catalog
cursor seeks were retained. Client checks now include 78 TS and 17 Rust tests.

Production rollout: GitHub main `e9a824670884c011785345daa300b1c8aab501ed`.
Owner-private Sites deployment `appgdep_6adb6ce53b1081918cf704a2ebb07623`
succeeded from synchronized Sites source `81c6255569f91b09ecbefffad9c72a4d230f6c46`
with environment revision 11. D1 now exposes jobs, receipt aliases and virtual
sort_time; migration history includes 0005 and 0006. Scoped worker GET /api/jobs
returns HTTP 200. The obsolete outbound webhook URL is removed from runtime
configuration; the worker uses a dedicated scoped secret.

Mac mini's Nix-generated service is running the new main revision (PID 83212).
Its health reports concurrency 2, active jobs and successful polling with no
transport error. Five real production jobs completed on their first attempt,
with persisted progress=1/error=null, while two more were active. Exhaustive
Notion import started with reset exactly once and continues in process PID 83423;
its private migration-run.json and log record the resumable cursor/counters/errors.
At the first verification, nine pages were safely skipped as existing primary
records and import remained active. Final migration completion is not yet proven.

The final combined release check passed 117 Node client/web tests plus 36 Bun
shared/daemon tests, all TypeScript projects, production Site build, and format/lint
with no warnings. Android's standalone local release APK is signed with the
existing development certificate, has embedded Hermes bytecode and passes 16KB
alignment/signature checks. It was not installed because no device is attached.

Cutover repair: the first importer stopped at 96 pages on a non-JSON gateway 500;
its cursor remained saved and a subsequent single-page retry succeeded. The run
was terminal before any stop signal. A cutover audit then found that 0005's old
cache ownership marker prevented a final source refresh and queued unnecessary
baseline backup writes. Migration 0007 and guarded import logic correct this:
untouched Notion baselines refresh once, edited/new primary records remain
protected, baseline snapshots never write back to Notion, and missing audio can
be hydrated independently without replacing titles or results. Race regressions
cover primary edits during network fetch and competing hydration transactions.

GitHub main `3a66119614d845a98438f80624a8b02ecbab9d87` is deployed through
owner-private Sites operation `appgdep_6adb70fb19b081919e0837427420db88`, source
`46d088e62a8eb27f08da16bfac8ffe308d4d3343`, environment 11. The full check passes
125 Node client/web tests, 36 Bun shared/daemon tests, all typechecks and the
production build; format/lint has zero warnings. D1 has notion_import_version.

Mac mini's unchanged API worker was resumed (PID 87834), health ok and polling
successfully. The explicit repair scan reset exactly once in process PID 87941,
with private log migration-repair-0007.log and state migration-repair-run.json.
It retains missing-source IDs and retries transient HTTP/network failures without
resetting; the first two source pages were reimported successfully. Final exhaustive
migration and physical-device verification remain outstanding. Running/paused
migration status now follows its active database lease, rather than the mere
presence of a saved cursor.

Further reliability checks: backup status now compares the confirmed backup
revision with the current primary revision; an old completed checkpoint alone
cannot claim a new edit is saved. Unconfigured backups and missing source audio
return explicit errors on retry. Concurrent rename/star updates change only their
provided fields in one atomic UPDATE RETURNING, with a regression forcing both
requests to read the same original row. Late browser responses cannot roll back
confirmed edits. API deadlines remain active when a lifecycle abort signal is
provided, and response-stream/invalid-JSON failures retain the operation context.
All TypeScript projects, combined client/web/shared/daemon tests, production Site
build and formatting/lint passed after these changes. Explicit storage diagnostics
were added to distinguish source identity/index cost from allocated free pages.

Live storage audit after diagnostics deployment
`appgdep_6adb7455f4708191b4fc7e7be537623d` (source
`76d41616e83ff71e45f745d6760bd7ea58f9c19a`, environment 11) succeeded through the
connected production `index_status` tool. It reported 213 recordings / 145 audio
copies and physical D1 size 121,171,968 bytes (115.56 MiB). The one additional
recording/audio copy is the parent's synthetic native verification recording.

Source ranges total 296,518 rows for 296,504 distinct prefixes, covering 1,317,449
frames (mean 4.443 frames/range). Device strings occupy 6,226,908 bytes and prefix
strings 25,797,038 bytes: 32,023,946 bytes (30.54 MiB) of identity payload before
SQLite/index overhead. Only 14 rows exceed the distinct-prefix count (0.0047%),
so useful range compaction is ruled out as a material remedy; distinct packet
hashes cannot be combined without losing source identity correctness. The largest
single recording has 11,013 ranges for 45,000 frames. Source identities and their
repeated composite keys in the two secondary indexes plausibly dominate storage,
but this is not a measured physical breakdown by table/index.

Original plus normalized transcript payload is only 96,293 bytes; FTS data plus
term payload is 89,929 bytes; legacy D1 manifest blobs total zero. Those payloads
do not explain the large physical allocation. D1 allows page_size (4,096 bytes)
but denies page_count and freelist_count with SQLITE_AUTH; these failures appear
as diagnostic fields without breaking index_status. Exact allocation/free-page
attribution and the cause of each earlier growth increment remain unmeasured.
No lossy source compression, range rewrite, VACUUM or storage schema change was
made during this read-only investigation. See docs/query-performance.md for the
numbers and interpretation limits.

Native Android end-to-end verification passed in an owned emulator with one
labeled synthetic tone upload: HTTP 401 retained the original audio, retry saved
the primary copy, restart preserved acknowledgements, and the real daemon job
completed on its second attempt after a transient speech-provider HTTP 400.
See docs/native-verification.md for exact retention checks, APK hash and cleanup.

That provider failure exposed an upstream diagnostic gap. The patched provider
now reads at most 8 KiB of failure response and retains bounded sanitized message,
code and request ID, while preserving HTTP status/retry metadata through chunk
wrapping. Credential redaction, bounded stream cancellation and real ffmpeg chunk
error propagation have regressions. All 21 transcriber tests, its typecheck/build,
and repository formatting/lint pass. Remote Nix applies this same repository patch;
activation of that next pinned source is recorded separately after verification.

Provider diagnostics activation was verified on 2026-10-24 at 00:01 JST. Mac mini's
Nix package pins `084fd8dbddcfd4a40399b2734f6966d50f30d131`, with unpacked source
hash `1pwlgwb678wqaip30c77c8iwyiqnykfq6a17fqdbvd5mrxxxfxvs`. The full declarative
mac-mini system closure built successfully at `~/dotfiles/result-uomi-api-diagnostics`.
Its generated user LaunchAgent was installed and reloaded; the previous plist and
private credentials remain backed up. Unrelated dotfiles changes were preserved.

The observed running daemon PID was 94578, executing
`/nix/store/jdaici78m37m3lmf6fqy3z711l7za0j0-uomi-transcriber-2026-10-23-084fd8d/lib/uomi-transcriber/transcriber.mjs`.
Launchd reported program `/nix/store/g1a3cgb9ih25wsb2i45vdzaq0052lphw-uomi-transcriber-launch`.
The compiled artifact independently contains the bounded error reader, request-ID
and redaction markers, chunk cause propagation, and `/api/jobs/claim`. `/health`
returned `status: ok`, `active: 0`, `concurrency: 2`, `error: null`, and a successful
poll at `2026-10-23T15:01:03.907Z`. This verifies the actual activated package,
rather than only the edited declaration or successful local tests.

The repair importer PID 87941 continued independently throughout the daemon update.
At the activation check it had processed 180 source pages: 168 cached, 11 unchanged,
one primary-owned skip, and 167 audio copies imported during this pass. Its one
historical missing-audio warning identified source page
`401f60d4-5c99-8169-9aca-d9e3c4031db1`, whose Audio and Manifest attachments were both
absent. `has_more` remained true; these observations do not establish exhaustive
migration or final unresolved counts. Later hydration can resolve earlier warnings,
so final source IDs must be reconciled with authoritative storage after exhaustion.
