// Development-only metadata polling fixture; production uses the authenticated API.
import { defineHandler } from 'void'
export const GET = defineHandler(() => ({
  id: 'preview',
  revision: 0,
  status: 'Completed',
  has_audio: false,
  backup_step: 'done',
  backup_error: null,
  transcription: null,
  detailed_transcription: null,
}))
