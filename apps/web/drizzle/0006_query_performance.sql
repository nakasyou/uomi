ALTER TABLE recordings ADD COLUMN sort_time INTEGER GENERATED ALWAYS AS (COALESCE(recorded_at,0)) VIRTUAL;
--> statement-breakpoint
CREATE INDEX recordings_page ON recordings(sort_time DESC,id DESC);
--> statement-breakpoint
-- Keep hot scans proportional to active work, rather than complete history.
CREATE INDEX recordings_starred_newest ON recordings(sort_time DESC,id DESC) WHERE starred=1;
--> statement-breakpoint
CREATE INDEX jobs_recent ON transcription_jobs(updated_at DESC,id DESC);
--> statement-breakpoint
CREATE INDEX jobs_due ON transcription_jobs(available_at,created_at,id) WHERE status IN ('queued','retry') AND attempt<max_attempts;
--> statement-breakpoint
CREATE INDEX jobs_expired ON transcription_jobs(lease_until,created_at,id) WHERE status='processing' AND attempt<max_attempts;
--> statement-breakpoint
CREATE INDEX jobs_exhausted ON transcription_jobs(lease_until,id) WHERE status='processing' AND attempt>=max_attempts;
--> statement-breakpoint
CREATE INDEX backup_due ON recordings(backup_next_attempt,backup_until,id) WHERE audio_key IS NOT NULL AND (backup_step NOT IN ('done','legacy') OR backup_revision<revision);
--> statement-breakpoint
CREATE INDEX source_recording ON source_ranges(recording_id);
--> statement-breakpoint
CREATE INDEX aliases_recording ON chunk_aliases(recording_id);
