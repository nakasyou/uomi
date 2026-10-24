ALTER TABLE recordings ADD COLUMN long_status TEXT;
--> statement-breakpoint
ALTER TABLE recordings ADD COLUMN long_text TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE recordings ADD COLUMN long_error TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
-- Preserve active leases and existing results while expanding the mode constraint.
CREATE TABLE transcription_jobs_next (
 id TEXT PRIMARY KEY,
 recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
 mode TEXT NOT NULL CHECK(mode IN ('standard','long','detailed')),
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','retry','completed','failed')),
 worker_id TEXT, lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 8,
 available_at INTEGER NOT NULL DEFAULT 0, stage TEXT NOT NULL DEFAULT 'queued',
 progress REAL NOT NULL DEFAULT 0, error TEXT, model TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 progress_detail TEXT NOT NULL DEFAULT '{}',
 UNIQUE(recording_id,mode)
);
--> statement-breakpoint
INSERT INTO transcription_jobs_next(id,recording_id,mode,status,worker_id,lease_token,lease_until,attempt,max_attempts,available_at,stage,progress,error,model,created_at,updated_at,progress_detail) SELECT id,recording_id,mode,status,worker_id,lease_token,lease_until,attempt,max_attempts,available_at,stage,progress,error,model,created_at,updated_at,progress_detail FROM transcription_jobs;
--> statement-breakpoint
DROP TABLE transcription_jobs;
--> statement-breakpoint
ALTER TABLE transcription_jobs_next RENAME TO transcription_jobs;
--> statement-breakpoint
CREATE INDEX jobs_claim ON transcription_jobs(status,available_at,lease_until,created_at);
--> statement-breakpoint
CREATE INDEX jobs_recent ON transcription_jobs(updated_at DESC,id DESC);
--> statement-breakpoint
CREATE INDEX jobs_due ON transcription_jobs(available_at,created_at,id) WHERE status IN ('queued','retry') AND attempt<max_attempts;
--> statement-breakpoint
CREATE INDEX jobs_expired ON transcription_jobs(lease_until,created_at,id) WHERE status='processing' AND attempt<max_attempts;
--> statement-breakpoint
CREATE INDEX jobs_exhausted ON transcription_jobs(lease_until,id) WHERE status='processing' AND attempt>=max_attempts;
--> statement-breakpoint
