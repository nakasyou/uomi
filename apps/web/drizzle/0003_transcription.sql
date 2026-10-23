CREATE TABLE transcriber_notifications(recording_id INTEGER PRIMARY KEY REFERENCES recordings(rid) ON DELETE CASCADE,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,delivered_at INTEGER,error TEXT);
--> statement-breakpoint
CREATE INDEX transcriber_due ON transcriber_notifications(delivered_at,next_attempt,lease_until);
