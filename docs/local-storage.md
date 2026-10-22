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
