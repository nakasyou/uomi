-- Explicit owner-requested reset of all transcript results on 2026-10-24.
-- Source audio, manifests, recording identity and optional external backups remain.
UPDATE recordings SET text='',search_text='',search_version=1,
 transcript_segments='[]',detailed_text='',detailed_segments='[]',
 status='Pending',detailed_status='Pending',detailed_error='',primary_owned=1,
 revision=revision+1,edited_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
--> statement-breakpoint
UPDATE transcription_jobs SET status='queued',stage='queued',progress=0,
 attempt=0,error=NULL,worker_id=NULL,lease_token=NULL,lease_until=0,
 available_at=0,model=NULL,updated_at=CAST(strftime('%s','now') AS INTEGER)*1000;
--> statement-breakpoint
INSERT INTO transcription_jobs(id,recording_id,mode,created_at,updated_at)
 SELECT id||':standard',id,'standard',CAST(strftime('%s','now') AS INTEGER)*1000,
 CAST(strftime('%s','now') AS INTEGER)*1000 FROM recordings
 WHERE audio_key IS NOT NULL ON CONFLICT(recording_id,mode) DO NOTHING;
--> statement-breakpoint
DELETE FROM transcriber_notifications;
