CREATE INDEX jobs_due_mode ON transcription_jobs(mode,available_at,created_at,id) WHERE status IN ('queued','retry') AND attempt<max_attempts;
--> statement-breakpoint
CREATE INDEX jobs_expired_mode ON transcription_jobs(mode,lease_until,created_at,id) WHERE status='processing' AND attempt<max_attempts;
