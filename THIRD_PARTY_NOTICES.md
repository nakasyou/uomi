# Third-party notices

Omi protocol implementation is adapted from [BasedHardware/omi](https://github.com/BasedHardware/omi), MIT © 2024 Based Hardware Contributors. See `licenses/omi-MIT.txt`.

Source references inspected: `app/lib/services/devices/models.dart`, `ring_protocol.dart`, `connectors/omi_connection.dart`, `app/lib/services/wals/sdcard_wal_sync.dart`, and `wal_frame_encoder.dart`. The reference checkout was fetched on 2026-10-21. Uomi is an independent client and is not affiliated with Based Hardware.

Design decisions use [pbakaus/impeccable](https://github.com/pbakaus/impeccable), including Material platform guidance and its craft floor. The skill itself is not redistributed here. UI components use React Native Paper (MIT) and Material Design Icons (Apache-2.0); their packages retain their upstream notices.

Linux desktop shell uses Tauri (MIT / Apache-2.0), btleplug (MIT / Apache-2.0), rusqlite (MIT), reqwest (MIT / Apache-2.0) and flate2 (MIT / Apache-2.0). Rust dependency versions are recorded in `src-tauri/Cargo.lock`.

## nTranscribe

The daemon depends on the MIT-licensed [nTranscribe](https://github.com/nakasyou/ntransctibe)
at commit `7b15b53b216163dcb2c49556c99f9b7716b0baad`, fetched by Bun from GitHub.
Its original license is distributed with the installed dependency. The local
Bun patch changes only its package export to the original TypeScript source;
no upstream runtime source is copied into this repository or modified.
