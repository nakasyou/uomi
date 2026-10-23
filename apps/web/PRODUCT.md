# Uomi Web Recorder

Single-owner web app. Notion is the source of truth for original Ogg Opus audio,
recording manifests, metadata and transcripts. D1 is a persistent metadata/full-text
cache; R2 is a persistent audio cache and temporary upload staging area.
The capture client imports Omi audio locally and sends one chunk per request.
A staging receipt does not acknowledge a canonical Notion save. Local audio remains
until a later sync confirms Notion storage. Web UI handles search, playback, text,
source resync and device credentials. Existing Bun daemon transcribes Notion pages.
No word timestamps, fabricated waveform or diarization are claimed.
