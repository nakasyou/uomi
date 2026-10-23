# Webhook contract

Uomi POSTs an HTTPS request directly to your configured endpoint. Successful HTTP **2xx** means the receiver has durably accepted **every** frame. Other responses, timeouts and redirects leave audio queued. Redirects are intentionally not followed because a secret header must not be forwarded to another server.

Headers:

```http
Content-Type: application/vnd.uomi.audio+json
Content-Encoding: gzip
X-Uomi-Secret: <your secret>
Idempotency-Key: <SHA-256 of the ordered frame ID array>
X-Uomi-Schema: 1
```

The secret header name is configurable. `Content-Encoding` is `gzip`, zlib-wrapped `deflate`, or absent for None. Compression wraps the JSON envelope; the audio stays **Opus, mono, 16 kHz**. This version does not transcode into MP3/AAC. The maximum duration is configured in minutes in Settings (decimals allowed, equivalent to 1–900 seconds), computed using the real Opus packet TOC, with a shorter final segment. The library, playback and delivery share these chunk boundaries. Sequence gaps, device/ring changes, clock reversals and forward device timestamp steps over 60 seconds start new chunks. Shorter timestamp gaps are shown in the library without adding silence or changing frame timestamps; partial retries send only the unacknowledged frames within a chunk. The real-time interval uses the same value; delivery can lag until Omi commits an on-device storage packet.

The decompressed JSON is:

```json
{
  "schema": "uomi.audio.v1",
  "segmentId": "<sha256>",
  "deviceId": "<hardware serial>",
  "codec": "opus",
  "sampleRate": 16000,
  "channels": 1,
  "durationMs": 20,
  "frames": [
    {
      "id": "<serial>:<packet digest>:0",
      "data": "<base64 Opus packet>",
      "durationMs": 20,
      "capturedAt": "2026-10-21T09:00:00.000Z",
      "offsetMs": 0,
      "recordTimestamp": 1792573200,
      "timing": "device-utc",
      "sequence": "9007199254740993",
      "ringId": "1234567890123456789"
    }
  ]
}
```

`capturedAt` is derived from the device UTC packet timestamp plus the frame's actual audio offset. Device timestamps have one-second resolution; subsecond offsets within a packet are derived, not extra device clock precision. Sequence and ring IDs are strings to preserve 64-bit values. `offsetMs` is relative to that packet, not the upload segment. When Omi records uptime instead of UTC, `capturedAt` is null and `timing` is `device-uptime`. The raw value is retained; Uomi does not silently invent a capture date. The device RTC is synced **after** downloading the existing snapshot, for subsequent recordings.

## Multiple clients and retries

Exactly-once delivery requires receiver cooperation. Use a **unique database constraint on every `frames[].id`**, in a transaction, and only return 2xx after the transaction commits. A segment key alone is insufficient: different clients can choose different segment lengths. Identical frame IDs preserve identity across compression choices, segmentation changes and HTTP retries. Packet identity includes the device serial, ring ID (where provided), ring sequence, and original packet content. Stock firmware reclaims recordings on BLE transfer, before local storage or HTTP acknowledgement. Uomi negotiates custody retention when advertised, but does not require it. Local recordings are retained after HTTP success and removed only by explicit user action. Retrieval by another client after a stock transfer is not guaranteed. The ring is finite; firmware may overwrite old recordings when full. The UI reports the firmware's dropped-packet count.

The local cursor is advanced only after a complete packet is committed to SQLite. A failed upload never advances its per-packet delivery cursor. Freeing delivered local audio leaves compact deduplication tombstones. A second client can retrieve the same remaining ring range, and its receiver must deduplicate overlaps. Only one BLE client can generally connect to a device at a time; competing clients retry on a later sync. There is no distributed BLE connection lock.

## Reference receiver

`receiver/server.py` uses only the Python standard library. It validates the envelope, supports all three compression options, and stores original Opus frames and timing metadata transactionally in SQLite. Its unique frame ledger handles overlapping segments from different clients. It is a starting point for your backend, not a transcription service or a complete internet-facing deployment.

```bash
export UOMI_WEBHOOK_SECRET='choose-a-long-random-secret'
python3 receiver/server.py --database /path/to/audio.sqlite
```

Place an HTTPS reverse proxy in front of `127.0.0.1:8787`, preserving `Content-Encoding`, `Idempotency-Key` and your secret header. Configure the app with `https://your-domain/audio`. Alternatively pass `--cert fullchain.pem --key privkey.pem` for direct TLS. Configure a matching `--secret-header` if changed in the app. Do not let an HTTP framework decompress the body twice.

The receiver stores length-delimited individual Opus packets as BLOBs with metadata; these are not standalone `.opus` files. A downstream consumer can decode individual packets with libopus or mux them into an Ogg container. Unknown device-time recordings remain explicitly untimed until your application applies its own time-reconciliation policy.

## Transcriber daemon webhook

This is separate from the capture upload webhook above. `POST /webhook` accepts
`Authorization: Bearer <UOMI_WEBHOOK_SECRET>` and JSON
`{"pageId":"<Notion page UUID>","mode":"standard|detailed"}`. Omitting `mode`
keeps standard behavior. Standard jobs use `TRANSCRIBER_PROVIDER`, defaulting to
`chrome-recognition`. Detailed jobs always use Codex and operate on the complete
recording (internally split into checkpointed requests).

Detailed requests may target a recording whose standard Status is Completed.
Audio and Manifest must already be attached in the configured Notion source.
The daemon durably marks Detailed status Pending before acknowledging a new job.
A 202 response with `accepted:true` means queued, not finished. Repeated in-flight
notifications return `accepted:false`; completed jobs additionally return
`completed:true` and are not rerun. Unknown modes or invalid pages return 400;
missing/incorrect bearer credentials return 401. No audio is sent in this request.

Detailed transcript/preview/status/error/attempts/retry-after properties are
separate from the standard properties. Automatic recovery scans both kinds at
startup and every 60 seconds. Failed jobs retain independent backoff and checkpoint
files. The Web Recorder writes the same durable request to Notion and optionally
sends this webhook as a wake-up. Closing the browser does not cancel the job.
