CREATE TABLE IF NOT EXISTS "candidates" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"url" text NOT NULL,
	"video_id" text NOT NULL,
	"title" text NOT NULL,
	"speaker" text DEFAULT '',
	"speaker_handle" text DEFAULT '',
	"channel" text DEFAULT '',
	"event" text DEFAULT '',
	"duration_s" integer DEFAULT 0,
	"published_at" timestamp with time zone,
	"detected_at" timestamp with time zone DEFAULT now(),
	"signal_strength" real DEFAULT 0,
	"figure_name" text,
	"status" text DEFAULT 'found' NOT NULL,
	"score" integer,
	"rationale" text DEFAULT '',
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clips" (
	"id" serial PRIMARY KEY NOT NULL,
	"candidate_id" integer,
	"start_s" real DEFAULT 0,
	"end_s" real DEFAULT 0,
	"hook_caption" text DEFAULT '',
	"post_text" text NOT NULL,
	"clip_url" text DEFAULT '',
	"x_post_id" text,
	"reply_to" text,
	"kind" text DEFAULT 'scout' NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"views" integer DEFAULT 0,
	"reshared_by_speaker" boolean DEFAULT false,
	"cost_usd" real DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now(),
	"posted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"ref_table" text,
	"ref_id" integer,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'scout' NOT NULL,
	"mock" boolean DEFAULT false,
	"started_at" timestamp with time zone DEFAULT now(),
	"finished_at" timestamp with time zone,
	"found" integer DEFAULT 0,
	"posted" integer DEFAULT 0,
	"skipped" integer DEFAULT 0,
	"errors" text DEFAULT ''
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"threshold" integer DEFAULT 70 NOT NULL,
	"autonomy" text DEFAULT 'review' NOT NULL,
	"summon_since_id" text,
	"x_bot_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "summon_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"tweet_id" text NOT NULL,
	"requester" text DEFAULT '',
	"target_url" text DEFAULT '',
	"status" text DEFAULT 'received' NOT NULL,
	"candidate_id" integer,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "clips" ADD CONSTRAINT "clips_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "summon_requests" ADD CONSTRAINT "summon_requests_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "candidates_video_id_idx" ON "candidates" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "candidates_status_idx" ON "candidates" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clips_status_idx" ON "clips" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_created_idx" ON "events" USING btree ("created_at");