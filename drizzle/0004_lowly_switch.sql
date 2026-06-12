CREATE TABLE IF NOT EXISTS "xbot_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"target_id" integer,
	"tweet_id" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "xbot_drafts" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"target_id" integer,
	"tweet_ref_id" integer,
	"in_reply_to_tweet_id" text,
	"context_text" text DEFAULT '',
	"text" text NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"x_post_id" text,
	"posted_at" timestamp with time zone,
	"edited_by_human" boolean DEFAULT false,
	"rationale" text DEFAULT '',
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "xbot_seeds" (
	"id" serial PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"x_user_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_mined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "xbot_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"paused" boolean DEFAULT true NOT NULL,
	"reply_autonomy" text DEFAULT 'review' NOT NULL,
	"post_autonomy" text DEFAULT 'review' NOT NULL,
	"likes_auto" boolean DEFAULT true NOT NULL,
	"daily_reply_cap" integer DEFAULT 20 NOT NULL,
	"daily_like_cap" integer DEFAULT 40 NOT NULL,
	"daily_post_cap" integer DEFAULT 2 NOT NULL,
	"cooldown_days" integer DEFAULT 3 NOT NULL,
	"quiet_start_utc" integer DEFAULT 4 NOT NULL,
	"quiet_end_utc" integer DEFAULT 12 NOT NULL,
	"max_followers" integer DEFAULT 5000 NOT NULL,
	"keywords" text DEFAULT '[]' NOT NULL,
	"search_since_id" text,
	"xbot_user_id" text,
	"voice_notes" text DEFAULT '',
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "xbot_targets" (
	"id" serial PRIMARY KEY NOT NULL,
	"x_user_id" text,
	"handle" text NOT NULL,
	"display_name" text DEFAULT '',
	"bio" text DEFAULT '',
	"followers" integer DEFAULT 0,
	"following" integer DEFAULT 0,
	"engagement_rate" real DEFAULT 0,
	"score" integer,
	"rationale" text DEFAULT '',
	"source" text DEFAULT 'manual' NOT NULL,
	"seed_handle" text,
	"status" text DEFAULT 'candidate' NOT NULL,
	"replies_sent" integer DEFAULT 0,
	"engaged_back" boolean DEFAULT false,
	"last_replied_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "xbot_tweets" (
	"id" serial PRIMARY KEY NOT NULL,
	"tweet_id" text NOT NULL,
	"target_id" integer,
	"author_handle" text NOT NULL,
	"text" text NOT NULL,
	"like_count" integer DEFAULT 0,
	"reply_count" integer DEFAULT 0,
	"tweeted_at" timestamp with time zone,
	"found_via" text DEFAULT 'search' NOT NULL,
	"liked" boolean DEFAULT false,
	"liked_at" timestamp with time zone,
	"status" text DEFAULT 'found' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "xbot_drafts" ADD CONSTRAINT "xbot_drafts_target_id_xbot_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."xbot_targets"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "xbot_drafts" ADD CONSTRAINT "xbot_drafts_tweet_ref_id_xbot_tweets_id_fk" FOREIGN KEY ("tweet_ref_id") REFERENCES "public"."xbot_tweets"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "xbot_tweets" ADD CONSTRAINT "xbot_tweets_target_id_xbot_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."xbot_targets"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "xbot_actions_kind_created_idx" ON "xbot_actions" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "xbot_drafts_status_idx" ON "xbot_drafts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "xbot_seeds_handle_idx" ON "xbot_seeds" USING btree ("handle");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "xbot_targets_handle_idx" ON "xbot_targets" USING btree ("handle");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "xbot_targets_status_idx" ON "xbot_targets" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "xbot_tweets_tweet_id_idx" ON "xbot_tweets" USING btree ("tweet_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "xbot_tweets_status_idx" ON "xbot_tweets" USING btree ("status");