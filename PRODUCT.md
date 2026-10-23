# Uomi

<!-- impeccable:product-schema 1 -->

## Platform

Android capture client, Linux Tauri capture client, responsive web recorder.
English UI, single owner with multiple personal devices.

## Product purpose

Preserve Omi recordings in R2 with authoritative D1 metadata, transcripts and
durable jobs. Notion is an optional asynchronous backup and migration source.
A committed server receipt confirms storage independently of Notion. Local
originals remain until explicit removal after confirmed storage. Never re-encode
source Opus packets.

## Surfaces

Capture client owns pairing, local import, durable queue, sync, progress and secure
Sites credentials. No library. Web Recorder owns listing, search, playback,
transcripts, job progress, retries, backup migration and key management. The Bun
daemon claims leased API jobs and reports progress/results. Structured results
accept timed segments and speaker labels when provided; never invent them.

## Stack

Bun / Vite+ monorepo; Void / React on Sites; React Native Paper for Android and
Tauri Linux. Native binary SQLite keeps source packet identities and capture
cursors. D1/R2 are primary storage; Notion backup has independent retries.
