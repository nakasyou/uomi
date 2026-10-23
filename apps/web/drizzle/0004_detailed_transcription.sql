ALTER TABLE recordings ADD COLUMN detailed_status TEXT;
--> statement-breakpoint
ALTER TABLE recordings ADD COLUMN detailed_text TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE recordings ADD COLUMN detailed_error TEXT NOT NULL DEFAULT '';
