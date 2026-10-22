# Uomi design

Material 3, Operate mode. Preserve the forest-green/sage palette, system typeface,
React Native Paper components, light and dark schemes, safe areas and 48dp actions.
Expanded layout uses a navigation rail; compact Android uses bottom navigation.

Library switches between On this device and In Notion below the heading. Notion
search stays above remote recordings, independent of local inventory length.
Local recordings offer playback; Notion recordings show audio metadata, processing
status and text. Distinguish Local only, Saved in
Notion, Awaiting transcription, Processing, Transcribed and Failed. Full text is
read inline. Keep lists bounded/paged and reuse expensive audio grouping across
progress paints. Search and status filters have useful empty states.

Devices is the sole sync destination. Unpaired devices lead with pairing and its
results before sync. Paired devices lead with a stable progress track and action
row, followed by device diagnostics, live monitoring and gain. Settings explains
Notion scope and credentials and offers an optional transcriber webhook behind a
disclosure. Settings drafts remain in memory
across tab navigation; explicit save and confirmed discard are available near the
top. Notion setup includes a guide and a save-and-check action that prepares the
database properties and refreshes recordings without uploading audio. Retention
copy follows the configured keep/remove policy on every screen. No S3 or
Cloudflare settings. All UI text is English. Never imply remote save means local
deletion, transcription completion, or a live Bluetooth connection.
