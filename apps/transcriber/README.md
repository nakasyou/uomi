# Transcriber

The daemon polls the web API's durable transcription queue. Notion is not involved in job scheduling, audio downloads, progress, results, or retries. `src/daemon.ts`, `coordinator.ts`, and `callbacks.ts` remain only for legacy migration tests; `src/index.ts` starts `ApiWorker`.

Copy `.env.example` into private service configuration. Set `UOMI_API_URL` to the web application's origin and `UOMI_CLIENT_SECRET` to the worker secret configured on the API (`UOMI_WORKER_SECRET`), or a client key issued by that application's Settings. The worker secret only permits job processing and audio/manifest downloads. During migration the API may use its existing `UOMI_WEBHOOK_SECRET` as this scoped worker secret. For a private Sites deployment, retain `SITES_ACCESS_TOKEN` so requests pass the Sites gateway as well. A Notion token cannot authenticate the new transport.

Run `bun run start` with Bun and ffmpeg on PATH. The default admission bounds are three Chrome recordings (including one analysis-prefetch slot) and two Codex recordings. FluidAudio runs one analysis, Chrome two recognitions, and Codex two requests independently, with at least ten seconds between Codex request starts. Detailed jobs use Codex; standard jobs use `TRANSCRIBER_PROVIDER`. The existing provider credentials stay on the daemon machine. The local HTTP server only exposes `/health`; old `/webhook` and `/reserve` calls return HTTP 410.

The worker claims up to its free concurrency slots, renews each 180-second lease every 30 seconds, and reports `downloading`, `decoding`, `transcribing`, and `saving` stages with chunk progress. The API stores attempts, failures, retry times, and results. A worker that loses its lease discards its result. A lost completion response is retried with the same token. Failed delivery never relies on an inbound callback.

Audio and manifests download concurrently from authenticated same-origin API endpoints. The worker verifies SHA-256 before invoking ffmpeg, bounds download sizes and decoder runtime, and checkpoints each successful provider chunk atomically in the private state directory. Restarted jobs reuse matching audio/provider/language/split-size checkpoints. HTTP failures retain status and response detail; processing failures include the failing stage and actual exception.

Provider segments, when available, use `{start_ms, end_ms, text, speaker}`. Chunk offsets are converted to the original audio playback timeline; original silence is retained. Providers returning only text produce no fabricated timestamps or speaker labels. Supporting providers can add timing and speaker output without changing the queue protocol.

On Mac mini, the service is managed by `~/dotfiles/modules/darwin/uomi-transcriber.nix` and its pinned source package. Update that declaration, build `.#darwinConfigurations.mac-mini.system`, apply the documented rebuild or generated user-agent update, and verify `/health` plus an actual completed queue job. Preserve the private credentials file and checkpoint directory. Do not finish deployment using an unmanaged background process.

`long` jobs always use Chrome recognition. They reuse the normalized FluidAudio
plan but merge all speaker boundaries and gaps up to 5000 ms, retaining source
silence inside each crop. Source spans split at the existing Google limit (600
seconds); unlike standard results, long results contain only ordered text and no
segments or speaker labels. Mode and merge policy isolate their checkpoints.

New uploads and newly imported audio automatically enqueue standard and long jobs.
Detailed remains an explicit request.


The durable API queue has independent `chrome` (standard/long) and `codex`
(detailed) claim lanes. Each retains FIFO order among ready work and fenced lease
recovery. Old callers can still claim the combined queue by omitting `queue`.
On Mac, separate abort-aware FluidAudio, Chrome, and Codex queues prevent one
provider's wait from consuming the other's recognition slots. The bounded Chrome
prefetch slot permits analysis while earlier audio is being recognized. Analysis
cache reads are repeated after acquiring the FluidAudio slot, so simultaneous
standard/long versions do not analyze identical audio twice. `/health` reports
active/waiting/maximum counts for each resource and admitted jobs per provider.
