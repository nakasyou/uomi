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
