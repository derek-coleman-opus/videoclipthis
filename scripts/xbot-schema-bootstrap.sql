-- FULL schema sync — brings any videoclipthis database up to what the current code
-- expects (drizzle migrations 0004 → 0010 plus legacy clip-bot columns). Written as ONE
-- statement (a single DO block) so it works in hosted SQL consoles like the Neon SQL
-- editor, which send input as a single prepared statement and reject multi-command
-- scripts ("cannot insert multiple commands into a prepared statement"). Idempotent:
-- safe to run repeatedly and safe on a database where any subset was already applied.
--
-- The same block is embedded in app/api/admin/migrate/route.ts (the one-click browser
-- sync). Per CLAUDE.md, every schema change must update BOTH places.

DO $$
BEGIN
  -- ── 0004: tables ──────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS "xbot_actions" (
    "id" serial PRIMARY KEY NOT NULL,
    "kind" text NOT NULL,
    "target_id" integer,
    "tweet_id" text,
    "created_at" timestamp with time zone DEFAULT now()
  );

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

  CREATE TABLE IF NOT EXISTS "xbot_seeds" (
    "id" serial PRIMARY KEY NOT NULL,
    "handle" text NOT NULL,
    "x_user_id" text,
    "active" boolean DEFAULT true NOT NULL,
    "last_mined_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS "xbot_settings" (
    "id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
    "paused" boolean DEFAULT true NOT NULL,
    "reply_autonomy" text DEFAULT 'review' NOT NULL,
    "post_autonomy" text DEFAULT 'review' NOT NULL,
    "likes_auto" boolean DEFAULT true NOT NULL,
    "daily_reply_cap" integer DEFAULT 20 NOT NULL,
    "daily_like_cap" integer DEFAULT 40 NOT NULL,
    "daily_post_cap" integer DEFAULT 3 NOT NULL,
    "cooldown_days" integer DEFAULT 3 NOT NULL,
    "quiet_start_utc" integer DEFAULT 22 NOT NULL,
    "quiet_end_utc" integer DEFAULT 14 NOT NULL,
    "max_followers" integer DEFAULT 5000 NOT NULL,
    "keywords" text DEFAULT '[]' NOT NULL,
    "search_since_id" text,
    "xbot_user_id" text,
    "voice_notes" text DEFAULT '',
    "updated_at" timestamp with time zone DEFAULT now()
  );

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

  BEGIN
    ALTER TABLE "xbot_drafts" ADD CONSTRAINT "xbot_drafts_target_id_xbot_targets_id_fk"
      FOREIGN KEY ("target_id") REFERENCES "public"."xbot_targets"("id") ON DELETE no action ON UPDATE no action;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;

  BEGIN
    ALTER TABLE "xbot_drafts" ADD CONSTRAINT "xbot_drafts_tweet_ref_id_xbot_tweets_id_fk"
      FOREIGN KEY ("tweet_ref_id") REFERENCES "public"."xbot_tweets"("id") ON DELETE no action ON UPDATE no action;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;

  BEGIN
    ALTER TABLE "xbot_tweets" ADD CONSTRAINT "xbot_tweets_target_id_xbot_targets_id_fk"
      FOREIGN KEY ("target_id") REFERENCES "public"."xbot_targets"("id") ON DELETE no action ON UPDATE no action;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;

  CREATE INDEX IF NOT EXISTS "xbot_actions_kind_created_idx" ON "xbot_actions" USING btree ("kind","created_at");
  CREATE INDEX IF NOT EXISTS "xbot_drafts_status_idx" ON "xbot_drafts" USING btree ("status");
  CREATE UNIQUE INDEX IF NOT EXISTS "xbot_seeds_handle_idx" ON "xbot_seeds" USING btree ("handle");
  CREATE UNIQUE INDEX IF NOT EXISTS "xbot_targets_handle_idx" ON "xbot_targets" USING btree ("handle");
  CREATE INDEX IF NOT EXISTS "xbot_targets_status_idx" ON "xbot_targets" USING btree ("status");
  CREATE UNIQUE INDEX IF NOT EXISTS "xbot_tweets_tweet_id_idx" ON "xbot_tweets" USING btree ("tweet_id");
  CREATE INDEX IF NOT EXISTS "xbot_tweets_status_idx" ON "xbot_tweets" USING btree ("status");

  -- ── 0005: growth-method defaults + playbook columns ──────────────────────
  ALTER TABLE "xbot_settings" ALTER COLUMN "daily_post_cap" SET DEFAULT 3;
  ALTER TABLE "xbot_settings" ALTER COLUMN "quiet_start_utc" SET DEFAULT 22;
  ALTER TABLE "xbot_settings" ALTER COLUMN "quiet_end_utc" SET DEFAULT 14;
  ALTER TABLE "xbot_drafts" ADD COLUMN IF NOT EXISTS "media_idea" text DEFAULT '';
  ALTER TABLE "xbot_settings" ADD COLUMN IF NOT EXISTS "mission" text DEFAULT '';
  ALTER TABLE "xbot_settings" ADD COLUMN IF NOT EXISTS "product_url" text DEFAULT '';
  ALTER TABLE "xbot_settings" ADD COLUMN IF NOT EXISTS "community_id" text DEFAULT '';
  ALTER TABLE "xbot_settings" ADD COLUMN IF NOT EXISTS "setup_checklist" text DEFAULT '[]' NOT NULL;

  -- ── 0006: engage-back (reply to everyone who comments) ───────────────────
  ALTER TABLE "xbot_settings" ADD COLUMN IF NOT EXISTS "daily_engage_cap" integer DEFAULT 50 NOT NULL;
  ALTER TABLE "xbot_settings" ADD COLUMN IF NOT EXISTS "mentions_since_id" text;

  -- ── 0007-0008: configurable niche + OpusClip brand template (clip bot) ───
  ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "niche" text DEFAULT 'AI / developer tooling' NOT NULL;
  ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "watch_channels" text DEFAULT '' NOT NULL;
  ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "opus_brand_template_id" text;

  -- ── legacy clip-bot columns/tables (pre-0007 databases) ──────────────────
  ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "summon_since_id" text;
  ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "x_bot_user_id" text;
  ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "figure_search_at" timestamp with time zone;
  ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "opus_project_id" text;
  CREATE TABLE IF NOT EXISTS "figures" (
    "id" serial PRIMARY KEY NOT NULL,
    "name" text NOT NULL,
    "x_handle" text NOT NULL,
    "org" text DEFAULT '',
    "role" text DEFAULT '',
    "priority" integer DEFAULT 2,
    "youtube_channel_id" text,
    "created_at" timestamp with time zone DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "figures_handle_idx" ON "figures" ("x_handle");

  -- ── 0009: safety-gate hold reason on auto-posted drafts ──────────────────
  ALTER TABLE "xbot_drafts" ADD COLUMN IF NOT EXISTS "hold_reason" text DEFAULT '';

  -- ── 0010: clip-bot production hardening ──────────────────────────────────
  ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "render_started_at" timestamp with time zone;
  ALTER TABLE "clips" ADD COLUMN IF NOT EXISTS "fail_reason" text DEFAULT '';
  ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "daily_clip_cap" integer DEFAULT 6 NOT NULL;

  -- Adopt the new pacing on a pre-existing settings row, only where the old
  -- Phase 1 defaults were never edited:
  UPDATE "xbot_settings" SET "daily_post_cap" = 3 WHERE "id" = 1 AND "daily_post_cap" = 2;
  UPDATE "xbot_settings" SET "quiet_start_utc" = 22, "quiet_end_utc" = 14
    WHERE "id" = 1 AND "quiet_start_utc" = 4 AND "quiet_end_utc" = 12;
END $$;
