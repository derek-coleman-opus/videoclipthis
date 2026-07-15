CREATE TABLE IF NOT EXISTS "clip_publishes" (
	"id" serial PRIMARY KEY NOT NULL,
	"clip_id" integer NOT NULL,
	"platform" text NOT NULL,
	"post_account_id" text NOT NULL,
	"account_name" text DEFAULT '',
	"status" text DEFAULT 'posted' NOT NULL,
	"task_id" text,
	"error" text DEFAULT '',
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "opus_clip_id" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "crosspost_accounts" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "clip_publishes" ADD CONSTRAINT "clip_publishes_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clip_publishes_clip_idx" ON "clip_publishes" USING btree ("clip_id");