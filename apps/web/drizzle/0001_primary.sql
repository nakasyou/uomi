ALTER TABLE recordings ADD COLUMN audio_key TEXT;
--> statement-breakpoint
ALTER TABLE recordings ADD COLUMN audio_sha TEXT;
--> statement-breakpoint
ALTER TABLE recordings ADD COLUMN duration_ms INTEGER;
--> statement-breakpoint
ALTER TABLE recordings ADD COLUMN manifest_gzip BLOB;
--> statement-breakpoint
ALTER TABLE recordings ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE recordings ADD COLUMN title TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE recordings ADD COLUMN backup_step TEXT NOT NULL DEFAULT 'legacy';
--> statement-breakpoint
ALTER TABLE recordings ADD COLUMN backup_error TEXT;
--> statement-breakpoint
ALTER TABLE recordings ADD COLUMN backup_page TEXT;
--> statement-breakpoint
ALTER TABLE recordings ADD COLUMN backup_audio TEXT;
--> statement-breakpoint
ALTER TABLE recordings ADD COLUMN backup_manifest TEXT;
--> statement-breakpoint
ALTER TABLE recordings ADD COLUMN backup_lease TEXT;
--> statement-breakpoint
ALTER TABLE recordings ADD COLUMN backup_until INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE recordings ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE recordings ADD COLUMN backup_revision INTEGER NOT NULL DEFAULT -1;
--> statement-breakpoint
CREATE INDEX backup_pending ON recordings(backup_step,backup_until);
--> statement-breakpoint
CREATE TABLE source_ranges(device TEXT NOT NULL,prefix TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,recording_id TEXT NOT NULL REFERENCES recordings(id),PRIMARY KEY(device,prefix,start));
--> statement-breakpoint
CREATE INDEX source_overlap ON source_ranges(device,prefix,end,start);
--> statement-breakpoint
CREATE TRIGGER no_source_overlap BEFORE INSERT ON source_ranges WHEN EXISTS(SELECT 1 FROM source_ranges WHERE device=NEW.device AND prefix=NEW.prefix AND start<NEW.end AND end>NEW.start) BEGIN SELECT RAISE(ABORT,'Source audio overlaps an existing chunk'); END;
--> statement-breakpoint
CREATE TABLE client_keys(hash TEXT PRIMARY KEY,name TEXT NOT NULL,created_at INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
--> statement-breakpoint
ALTER TABLE recordings ADD COLUMN notion_edited TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX notion_page_unique ON recordings(backup_page) WHERE backup_page IS NOT NULL;
--> statement-breakpoint
CREATE TABLE resync_state(id INTEGER PRIMARY KEY CHECK(id=1),cursor TEXT,since TEXT NOT NULL,started TEXT,lease_until INTEGER NOT NULL DEFAULT 0);
--> statement-breakpoint
CREATE INDEX recordings_newest ON recordings(COALESCE(recorded_at,0) DESC,id DESC);
