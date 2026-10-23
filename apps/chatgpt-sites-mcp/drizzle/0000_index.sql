CREATE TABLE recordings (id TEXT PRIMARY KEY, recorded_at INTEGER, finished_at INTEGER, edited_at TEXT NOT NULL, device TEXT NOT NULL, status TEXT NOT NULL, url TEXT NOT NULL, text TEXT NOT NULL);
--> statement-breakpoint
CREATE INDEX recordings_time ON recordings(recorded_at, id);
--> statement-breakpoint
CREATE INDEX recordings_end ON recordings(finished_at, id);
--> statement-breakpoint
CREATE VIRTUAL TABLE transcripts USING fts5(id UNINDEXED, text, tokenize='trigram');
--> statement-breakpoint
CREATE TABLE sync_state (id INTEGER PRIMARY KEY CHECK(id=1), watermark TEXT NOT NULL, cursor TEXT, cycle_start TEXT, scanned INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0);
--> statement-breakpoint
INSERT INTO sync_state(id,watermark) VALUES(1,'1970-01-01T00:00:00.000Z');
