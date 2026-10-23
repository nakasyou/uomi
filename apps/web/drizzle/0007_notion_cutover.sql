-- Cached Notion snapshots need one explicit cutover refresh. Primary edits and
-- new uploads are never import candidates, even if their import version is zero.
ALTER TABLE recordings ADD COLUMN notion_import_version INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE recordings SET backup_revision=revision,backup_error=NULL,backup_next_attempt=0,
  backup_attempts=0,backup_lease=NULL,backup_until=0
  WHERE notion_edited IS NOT NULL AND revision=0;
--> statement-breakpoint
DROP INDEX backup_due;
--> statement-breakpoint
CREATE INDEX backup_due ON recordings(backup_next_attempt,backup_until,id)
  WHERE audio_key IS NOT NULL AND (notion_edited IS NULL OR revision>0)
  AND (backup_step NOT IN ('done','legacy') OR backup_revision<revision);
