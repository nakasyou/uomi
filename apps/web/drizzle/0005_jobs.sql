ALTER TABLE recordings ADD COLUMN backup_next_attempt INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE recordings ADD COLUMN backup_attempts INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE recordings ADD COLUMN primary_owned INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE recordings ADD COLUMN transcript_segments TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE recordings ADD COLUMN detailed_segments TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
UPDATE recordings SET primary_owned=1 WHERE audio_key IS NOT NULL;
--> statement-breakpoint
CREATE TABLE transcription_jobs (
 id TEXT PRIMARY KEY,
 recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
 mode TEXT NOT NULL CHECK(mode IN ('standard','detailed')),
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','retry','completed','failed')),
 worker_id TEXT, lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 8,
 available_at INTEGER NOT NULL DEFAULT 0, stage TEXT NOT NULL DEFAULT 'queued',
 progress REAL NOT NULL DEFAULT 0, error TEXT, model TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(recording_id,mode)
);
--> statement-breakpoint
CREATE INDEX jobs_claim ON transcription_jobs(status,available_at,lease_until,created_at);
--> statement-breakpoint
INSERT INTO transcription_jobs(id,recording_id,mode,created_at,updated_at)
SELECT id||':standard',id,'standard',0,0 FROM recordings WHERE audio_key IS NOT NULL AND status NOT IN ('Completed','Uploading');

--> statement-breakpoint
CREATE TABLE chunk_aliases(id TEXT PRIMARY KEY,audio_sha TEXT NOT NULL,recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE);

--> statement-breakpoint
ALTER TABLE resync_state ADD COLUMN last_error TEXT;
--> statement-breakpoint
ALTER TABLE resync_state ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
