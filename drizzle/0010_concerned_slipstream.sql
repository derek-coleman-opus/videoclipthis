ALTER TABLE "candidates" ADD COLUMN "render_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "fail_reason" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "daily_clip_cap" integer DEFAULT 6 NOT NULL;