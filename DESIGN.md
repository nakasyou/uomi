# Uomi design

Material 3, Operate mode, English. The capture client is a narrow sync tool with
Sync and Settings, durable-state progress, Omi pairing and a Web Recorder link.
Use React Native Paper, system type, light/dark themes and 48dp touch targets.

Web visual authority is the supplied Google Recorder screenshot: charcoal canvas,
blue transport controls, left recording list, a rounded split waveform/transcript
panel and fixed playback controls. See apps/web/DESIGN.md for its tokens. Mobile
stacks reading and waveform, with a recordings drawer. Never synthesize a fake
waveform or word timestamps. Server storage, transcription and optional Notion
backup are distinct states. Removal requires a confirmed server save receipt.
Show operation-specific failures with their diagnostic details and retry action.
