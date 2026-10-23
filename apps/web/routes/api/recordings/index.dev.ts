// Development-only visual QA sample. Void excludes .dev routes from production.
import { defineHandler } from 'void'
export const GET = defineHandler(() => ({
  results: [
    {
      id: 'preview',
      title: 'Interface verification sample',
      recorded_at: 1792713600000,
      finished_at: 1792714200000,
      duration_ms: 600000,
      status: 'Completed',
      starred: false,
      has_audio: false,
      backup_step: 'done',
      backup_error: null,
    },
  ],
  next_cursor: null,
}))
