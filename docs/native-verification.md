# Native Android verification — 2026-10-23

A fresh, owned Android 35 x86_64 emulator exercised the actual React Native
release APK, Android SQLite/Keystore, native HTTP transport, deployed API and
transcription daemon. The emulator used an already installed system image and
ran headlessly. Existing AVDs, the running Linux capture client, its database and
personal recordings were not used as fixtures or modified.

## Fixture and actions

The only uploaded recording was generated locally: 2.02 seconds of 440 Hz tone,
101 valid original Opus packets. Its source device ID starts `uomi-native-qa-`.
It was seeded into the isolated app database with manual sync, no paired device
and automatic local removal disabled. Existing destination credentials were
entered through normal native Settings, without printing their values or
changing their original storage.

1. Invalid fixture API key: **Upload local audio** returned HTTP 401 with the
   server's JSON authentication error visible in the app. Sync paused, all 101
   frames remained pending and local removal stayed disabled. A stopped-app
   SQLite snapshot confirmed the original audio BLOB was unchanged.
2. Correct key: the same normal upload action saved one chunk. The app displayed
   `1 confirmed`, zero pending recordings and the real transcription job.
   Both native metadata tables acknowledged all 101 frames. The 17,394-byte
   original BLOB remained byte-for-byte identical and remained on the device.
3. The daemon claimed the job. Attempt 1 exposed `Speech downstream HTTP 400`
   in the app; automatic retry completed on attempt 2. The final API status is
   `completed`, progress `1`, error `null`, with audio present and backup saved.
   This non-speech tone does not test spoken-word recognition accuracy.
4. After force-stop/relaunch, saved state, encrypted credentials and the same
   completed job were restored. Installing the same-certificate APK update also
   preserved those states and the unchanged original BLOB. No additional upload
   was performed and no fatal app crash was found in the app's crash buffer.

The production fixture was labeled **QA — synthetic Android native transport
test (2026-10-23)**. Its recording ID is
`c5a7aba16257539bdac56b7dbdc7d115f156d2304a9986353a3f9ef5192c107c`.
It is retained as an identifiable QA recording; no personal audio was uploaded.

## Artifact and UI correction

The native light-theme status bar initially rendered white icons on its pale
background. A theme-aware React Native `StatusBar` fixes that contrast; the
updated installed APK was checked visually on the emulator.

Standalone artifact (no Metro required):
`apps/client/android/app/build/outputs/apk/release/uomi-local-release.apk`.
It embeds compiled Hermes bytecode and supports arm64-v8a, armeabi-v7a, x86 and
x86_64. It uses the existing development certificate, not a production signing
key. The keystore was not changed. APK v2/v3 signatures and 16 KB ZIP alignment
were verified.

- Size: 57,775,232 bytes.
- SHA-256: `bd5cecc50233da084627a2c36465de26dc71d4d66aba4eebf7b4dd55120e46b3`.

Credential-free screenshots and result summaries are retained locally in
`/tmp/uomi-native-qa-evidence/`. The temporary emulator and its private app data,
credential copies, AVD and SQLite snapshots were removed after verification.

## Limits

This verifies native emulator UI, persistence, upload failure/retry, primary-save
acknowledgement, retention and real server/daemon state. Physical Omi Bluetooth
capture, radio throughput and physical-phone battery/background behavior still
require connected hardware. No physical Android device was attached.
