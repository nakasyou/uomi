import { defineHandler } from 'void'
export const GET = defineHandler(() => ({
  id: 'preview',
  revision: 0,
  title: 'Interface verification sample',
  recorded_at: 1792713600000,
  duration_ms: 600000,
  status: 'Completed',
  starred: false,
  has_audio: false,
  backup_step: 'done',
  backup_error: null,
  text: 'This recording is a development-only interface sample. It contains no personal conversation.\n\nThe server stores audio and transcripts. Notion is an optional backup.\n\nThe capture client handles Bluetooth import and synchronization. Recordings stay on the device until server storage is confirmed.',
}))
