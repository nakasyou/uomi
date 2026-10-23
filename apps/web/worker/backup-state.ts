// Checkpoints describe work already attempted; they do not prove the latest
// primary revision is backed up. Keep this distinction consistent across APIs.
export function backupState(env: any, row: any, now = Date.now()) {
  const configured = !!(env.NOTION_TOKEN && env.NOTION_DATA_SOURCE_ID)
  const hasAudio = row.has_audio === undefined ? !!row.audio_key : !!row.has_audio
  const current = Number.isInteger(row.backup_revision) && row.backup_revision >= row.revision
  const saved =
    configured &&
    hasAudio &&
    current &&
    !row.backup_error &&
    ['done', 'legacy'].includes(row.backup_step)
  const status = !configured
    ? 'disabled'
    : !hasAudio
      ? 'missing_audio'
      : saved
        ? 'saved'
        : row.backup_step === 'uncertain'
          ? 'uncertain'
          : row.backup_until > now
            ? 'processing'
            : row.backup_error
              ? 'retry'
              : 'pending'
  return {
    backup_configured: configured,
    backup_status: status,
    backup_saved: saved,
    backup_revision: row.backup_revision,
    revision: row.revision,
  }
}
