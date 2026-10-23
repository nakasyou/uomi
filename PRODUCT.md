# Uomi

<!-- impeccable:product-schema 1 -->

## Platform

Android capture client, Linux Tauri capture client, responsive web recorder.
English UI, single owner with multiple personal devices.

## Product purpose

Preserve Omi recordings in Notion, with fast search and playback from persistent
D1 metadata/transcript and R2 original-audio caches. Cache storage is rebuildable
from Notion. Staged uploads are not canonical saves. Keep local originals until
Notion persistence is confirmed. Never re-encode source Opus packets.

## Surfaces

Capture client owns pairing, local import, durable queue, sync, progress and secure
Sites credentials. No library. Web Recorder owns listing, search, playback,
transcripts, source resync and key management. Bun daemon continues transcribing
Notion pages. No per-word transcript times or diarization are claimed.

## Stack

Bun / Vite+ monorepo; Void / React on Sites; React Native Paper for Android and
Tauri Linux. Native binary SQLite keeps source packet identities and capture
cursors. Notion is canonical; D1 and R2 are caches and upload staging resources.
