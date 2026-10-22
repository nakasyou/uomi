# Uomi

<!-- impeccable:product-schema 1 -->

## Platform

android

Also ships on Linux using React Native Web inside Tauri. English UI.

## Stack

Vite+ / Bun monorepo. apps/client is React Native Android and Tauri Linux.
apps/transcriber is a TypeScript/Bun webhook daemon using nTranscribe and ffmpeg.
packages/notion owns shared direct Notion API/storage contracts. Notion is the
remote database and audio store. No S3 or Cloudflare infrastructure is required.

## Product Purpose

Preserve Omi recordings locally, sync directly to the user's Notion database,
and bring their transcripts back into the audio library.

## Capabilities and Constraints

Devices owns import/sync, progress, pairing, microphone gain and live debug audio.
Library owns local playback, Notion save/processing status and searchable transcript
previews with full text on demand. Settings owns scoped Notion credentials and the
optional transcriber webhook. Manual mode is the default without continuous
background activity. Periodic mode uses scheduled Wi-Fi jobs; real-time mode uses
native background activity. Imported original Opus frames are never re-encoded.
Local audio is automatically removed only after verified Notion upload when the retention setting is enabled; users can retain copies instead. No update feature. Stable frame
IDs and manifests preserve timing and reconciliation across clients. Notion has
no atomic uniqueness or job-claim constraint; do not claim exactly-once processing.

## Product Principles

Preserve originals. Show actual storage and processing state separately. Scope
credentials to a dedicated database. Keep the user's services under their control.

## Verified sync and scale

The client uses compact packet indexes and loads audio only for a bounded number
of chunks. Notion sync is incremental with cached manifests and paged history.
A single daemon coordinates page reservations using a local SQLite index; audio
still uploads directly to Notion. It automatically recovers unnotified and failed
transcription jobs. Before automatic local removal, the client verifies the saved
manifest and audio hash; cross-client copies also require matching original
packets and timing. Same-device audio is combined with encoded Opus silence only
when the entire next run fits within the configured maximum.
