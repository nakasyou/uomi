# Uomi Recorder

Single-owner recorder. D1 owns recording metadata, transcript results and durable
transcription jobs; R2 owns uploaded Ogg Opus audio and manifests. A verified R2
write plus committed D1 metadata acknowledges a saved recording to the client.
Notion is optional asynchronous backup and a migration source for earlier recordings.
Its availability never blocks capture, saved receipts, playback or transcription.

The capture client stores originals locally, uploads bounded independently retriable
chunks and displays server storage and transcription states separately. The web UI
supports search, playback, title/star edits, job progress, errors and retries. The
Mac mini daemon claims leased API jobs, reports progress, and commits fenced results.
Results accept timestamped segments and optional speaker identifiers; the UI only
shows timestamps/speakers actually returned by the provider.
