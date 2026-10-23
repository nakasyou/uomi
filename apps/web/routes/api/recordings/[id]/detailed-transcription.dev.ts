// Development-only UI sample; no audio is sent and no provider is called.
import { defineHandler } from 'void'
let requestedAt: number | null = null
const result = () => ({
  detailed_status:
    requestedAt === null ? null : Date.now() - requestedAt < 1200 ? 'Pending' : 'Completed',
  detailed_text:
    requestedAt !== null && Date.now() - requestedAt >= 1200
      ? 'Development-only Codex transcript sample.\n\nThe detailed version is stored separately, so the standard transcript remains available.'
      : '',
  detailed_error: '',
})
export const GET = defineHandler(result)
export const POST = defineHandler(() => {
  requestedAt ??= Date.now()
  return result()
})
