CREATE TABLE recordings_next(rid INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,recorded_at INTEGER,finished_at INTEGER,edited_at TEXT NOT NULL,device TEXT NOT NULL,status TEXT NOT NULL,url TEXT NOT NULL,text TEXT NOT NULL,audio_key TEXT,audio_sha TEXT,duration_ms INTEGER,manifest_gzip BLOB,starred INTEGER NOT NULL DEFAULT 0,title TEXT NOT NULL DEFAULT '',backup_step TEXT NOT NULL DEFAULT 'legacy',backup_error TEXT,backup_page TEXT,backup_audio TEXT,backup_manifest TEXT,backup_lease TEXT,backup_until INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,backup_revision INTEGER NOT NULL DEFAULT -1,notion_edited TEXT,search_text TEXT NOT NULL DEFAULT '',search_version INTEGER NOT NULL DEFAULT 0,manifest_key TEXT);
--> statement-breakpoint
INSERT INTO recordings_next(rid,id,recorded_at,finished_at,edited_at,device,status,url,text,audio_key,audio_sha,duration_ms,manifest_gzip,starred,title,backup_step,backup_error,backup_page,backup_audio,backup_manifest,backup_lease,backup_until,revision,backup_revision,notion_edited) SELECT rowid,id,recorded_at,finished_at,edited_at,device,status,url,text,audio_key,audio_sha,duration_ms,manifest_gzip,starred,title,backup_step,backup_error,backup_page,backup_audio,backup_manifest,backup_lease,backup_until,revision,backup_revision,notion_edited FROM recordings;
--> statement-breakpoint
CREATE TABLE source_ranges_next(device TEXT NOT NULL,prefix TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,recording_id INTEGER NOT NULL REFERENCES recordings_next(rid) ON DELETE CASCADE,PRIMARY KEY(device,prefix,start)) WITHOUT ROWID;
--> statement-breakpoint
INSERT INTO source_ranges_next SELECT s.device,s.prefix,s.start,s.end,r.rowid FROM source_ranges s JOIN recordings r ON r.id=s.recording_id;
--> statement-breakpoint
DROP TABLE source_ranges;
--> statement-breakpoint
DROP TABLE transcripts;
--> statement-breakpoint
DROP TABLE recordings;
--> statement-breakpoint
ALTER TABLE recordings_next RENAME TO recordings;
--> statement-breakpoint
ALTER TABLE source_ranges_next RENAME TO source_ranges;
--> statement-breakpoint
CREATE INDEX recordings_time ON recordings(recorded_at,id);
--> statement-breakpoint
CREATE INDEX recordings_end ON recordings(finished_at,id);
--> statement-breakpoint
CREATE INDEX recordings_newest ON recordings(COALESCE(recorded_at,0) DESC,id DESC);
--> statement-breakpoint
CREATE INDEX backup_pending ON recordings(backup_step,backup_until);
--> statement-breakpoint
CREATE UNIQUE INDEX notion_page_unique ON recordings(backup_page) WHERE backup_page IS NOT NULL;
--> statement-breakpoint
CREATE INDEX source_overlap ON source_ranges(device,prefix,end,start);
--> statement-breakpoint
CREATE TRIGGER no_source_overlap BEFORE INSERT ON source_ranges WHEN EXISTS(SELECT 1 FROM source_ranges WHERE device=NEW.device AND prefix=NEW.prefix AND start<NEW.end AND end>NEW.start) BEGIN SELECT RAISE(ABORT,'Source audio overlaps an existing chunk'); END;
--> statement-breakpoint
CREATE VIRTUAL TABLE transcripts USING fts5(search_text,content='recordings',content_rowid='rid',tokenize='trigram',detail=none,columnsize=0);
--> statement-breakpoint
CREATE TRIGGER search_insert AFTER INSERT ON recordings WHEN NEW.search_version=1 BEGIN INSERT INTO transcripts(rowid,search_text) VALUES(NEW.rid,NEW.search_text); END;
--> statement-breakpoint
CREATE TRIGGER search_delete AFTER DELETE ON recordings WHEN OLD.search_version=1 BEGIN INSERT INTO transcripts(transcripts,rowid,search_text) VALUES('delete',OLD.rid,OLD.search_text); END;
--> statement-breakpoint
CREATE TRIGGER search_update AFTER UPDATE OF search_text,search_version ON recordings BEGIN INSERT INTO transcripts(transcripts,rowid,search_text) SELECT 'delete',OLD.rid,OLD.search_text WHERE OLD.search_version=1; INSERT INTO transcripts(rowid,search_text) SELECT NEW.rid,NEW.search_text WHERE NEW.search_version=1; END;
--> statement-breakpoint
CREATE INDEX search_backfill ON recordings(search_version,rid);

--> statement-breakpoint
CREATE TRIGGER search_dirty AFTER UPDATE OF text ON recordings WHEN NEW.text<>OLD.text AND NEW.search_text=OLD.search_text AND NEW.search_version=OLD.search_version BEGIN UPDATE recordings SET search_version=0 WHERE rid=NEW.rid; END;

--> statement-breakpoint
DROP TABLE sync_state;
