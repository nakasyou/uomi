# Local audio storage and bulk import

Android and Linux store encoded Opus packets as BLOBs in `recording_audio(key,data)`.
Each packet is framed by an unsigned little-endian 16-bit byte length. No PCM
conversion, compression setting change or lossy re-encoding is involved.

The existing `kv` recording key remains the stable source identity. New values are
versioned (`binaryAudio: 1`) metadata envelopes: recording metadata, compact frame
identity and duration descriptors, and only exceptional per-frame offsets or extra
fields. They contain no Base64 audio. `record_index` serves the compact library
catalog. Native getters reconstruct the previous recording API only for requested
recordings, so playback, checkpoints and Notion source identities remain compatible.
Code reading SQLite directly must understand this format rather than assume every
`kv.value` has a `frames` array.

Legacy JSON is readable alongside the new format. After the library opens, the
foreground idle client asks the native store to migrate at most 128 records per
transaction. Migration pauses during sync and outside the foreground, and resumes
on the next foreground session. A failed conversion rolls back its transaction;
the original recording stays readable. Freed SQLite pages are reused; the database
file is not automatically vacuumed or guaranteed to shrink immediately.

Bulk imports request at most 1,024 ring packets (444 KiB raw). Native code validates
READ_BEGIN, assembles the byte stream across BLE notifications, and commits every
32 complete packets. Receipt and storage overlap within that bounded range. Packet
hashes, packet parsing and new binary writes stay native, without a Base64 audio
round trip. Existing recordings and seen tombstones are checked in the same
transaction. The durable cursor advances only in the transaction containing those
recordings. SQLite remains WAL + synchronous FULL. Cancel/timeout paths preserve
fully assembled packets where storage is still writable, and never claim success
for incomplete DONE or an incomplete native result.

Only progress/transfer measurements cross the UI bridge during import. The UI
reports packets/s, KiB/s and the fraction of time spent in native storage. Android
requests high connection priority and 2M PHY where supported; the OS/device still
controls negotiated settings. Android reports actual MTU and PHY callbacks. Linux
queries BlueZ's characteristic MTU and, if unavailable, explicitly displays the
observed notification-size lower bound; PHY and connection interval remain unknown
when the OS does not expose them through the available interface.

Stock Omi firmware can reclaim BLE-delivered ring data before the application
commits it. Application transactions cannot turn that into an app-acknowledged
firmware protocol. This change preserves the existing firmware policy, sends no
CLEAR/DELETE/ADVANCE command, and does not promise power-loss safety for bytes that
have not committed. Custody firmware with app-acknowledged reclaim is a separate
capability.

Rebuild and restart the native client to load the new commands and schema. A
frontend hot reload alone cannot upgrade native storage or BLE processing.

### Linux BLE measurement logs

Native debug builds (including `bun run linux`) emit `UOMI_BLE_TRACE` followed by
JSON to stderr. Set `UOMI_BLE_TRACE=0` to disable, or `UOMI_BLE_TRACE=1` to enable
in a release build. Restart the native process after changing the environment;
frontend reloads alone do not apply native changes. Tauri dev normally rebuilds
and restarts the native process when Rust sources change.

Each bounded import emits `start`, cumulative `progress` about every two seconds,
and `done` or `error`. Logs contain counts and timings, not audio, device IDs,
timestamps from recordings, or credentials. `received_bytes` counts ring DATA
payload (including record headers/padding), and `kib_per_s` is the cumulative
application throughput, including command startup and storage waits. Each range
resets these counters; this is not the radio's raw bitrate.

- `queue_peak_sampled` (capacity 64) samples pending notifications before/after
  receive and after commits. It is a lower bound on peak occupancy.
- `receiver_backpressure` aggregates sends that found the queue full: their count,
  total wait, and maximum wait. Windows flush at most every two seconds and at
  DONE; disconnect/cancellation can leave a final partial window unreported.
- `commit_wall_ms` and `commit_max_ms` include blocking-worker scheduling and all
  local persistence work; `storage_ms` starts inside that worker and includes DB
  lock wait, record preparation, SQL and transaction commit. They overlap;
  do not add them together. Neither isolates fsync time.
- `receive_wait_ms`/`receive_wait_max_ms` measure time awaiting the next queued
  notification, not radio packet spacing. `parse_ms` measures ring assembly.
  `first_data_ms` measures from import startup to first DATA consumption and
  `command_ms` measures the control write round trip.

A saturated queue plus receiver backpressure points to local processing stalls.
Low storage/parse time and long receive waits points upstream of this consumer
(BLE, BlueZ, firmware or SD), without distinguishing those causes. Error metrics
are captured before cancellation cleanup salvages any remaining complete records.

For actual PHY, connection interval and Data Length, start `sudo btmon` before
connecting Omi, then import once. Inspect LE PHY Update Complete, LE Connection
Update Complete and LE Data Length Change events alongside application logs.
These values are not exposed by the current btleplug import interface. A btmon
capture can contain audio payloads and device addresses; keep it local.
