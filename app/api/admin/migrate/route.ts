import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// One-click schema sync (admin basic-auth via middleware). Open in a browser:
//   GET /api/admin/migrate
// Brings an existing database up to what the clip-pipeline code expects, idempotently — so we
// never again break the whole app by forgetting to hand-run an ALTER in Neon. Every statement
// uses IF NOT EXISTS, so it's safe to run repeatedly. (The XBot tables have their own bootstrap
// in scripts/xbot-schema-bootstrap.sql.)
const STATEMENTS: string[] = [
  // settings: niche + watch-channels (NOT NULL with defaults so existing rows backfill cleanly)
  `ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "niche" text NOT NULL DEFAULT 'AI / developer tooling'`,
  `ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "watch_channels" text NOT NULL DEFAULT ''`,
  `ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "opus_brand_template_id" text`,
  `ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "search_topics" text NOT NULL DEFAULT ''`,
  `ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "search_offset" integer NOT NULL DEFAULT 0`,
  `ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "summon_since_id" text`,
  `ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "x_bot_user_id" text`,
  `ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "figure_search_at" timestamp with time zone`,
  // settings: daily auto-post volume cap (migration 0010)
  `ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "daily_clip_cap" integer NOT NULL DEFAULT 6`,
  // candidates: OpusClip project id for two-phase rendering + submission timestamp
  // (render-timeout clock, migration 0010)
  `ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "opus_project_id" text`,
  `ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "render_started_at" timestamp with time zone`,
  // clips: retriable publish failures carry their reason (migration 0010)
  `ALTER TABLE "clips" ADD COLUMN IF NOT EXISTS "fail_reason" text DEFAULT ''`,
  `ALTER TABLE "xbot_tweets" ADD COLUMN IF NOT EXISTS "view_count" integer DEFAULT 0`,
  // xbot: per-component health ledger (the "why did it stop" table)
  `CREATE TABLE IF NOT EXISTS "xbot_health" (
     "id" serial PRIMARY KEY NOT NULL,
     "component" text NOT NULL,
     "last_run_at" timestamp with time zone,
     "last_ok_at" timestamp with time zone,
     "last_error_at" timestamp with time zone,
     "last_error" text DEFAULT '',
     "consecutive_errors" integer NOT NULL DEFAULT 0
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "xbot_health_component_idx" ON "xbot_health" ("component")`,
  // xbot: account-lock circuit breaker (0014) + clamp stored caps to the new hard maxima
  `ALTER TABLE "xbot_settings" ADD COLUMN IF NOT EXISTS "lock_detected_at" timestamp with time zone`,
  `ALTER TABLE "xbot_settings" ADD COLUMN IF NOT EXISTS "lock_reason" text DEFAULT ''`,
  `UPDATE "xbot_settings" SET
     "daily_like_cap" = LEAST("daily_like_cap", 80),
     "daily_reply_cap" = LEAST("daily_reply_cap", 20),
     "daily_engage_cap" = LEAST("daily_engage_cap", 30),
     "daily_post_cap" = LEAST("daily_post_cap", 5)`,
  // clips: multi-platform cross-posting via OpusClip post-tasks (0015)
  `ALTER TABLE "clips" ADD COLUMN IF NOT EXISTS "opus_clip_id" text`,
  `ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "crosspost_accounts" text NOT NULL DEFAULT '[]'`,
  `CREATE TABLE IF NOT EXISTS "clip_publishes" (
     "id" serial PRIMARY KEY NOT NULL,
     "clip_id" integer NOT NULL,
     "platform" text NOT NULL,
     "post_account_id" text NOT NULL,
     "account_name" text DEFAULT '',
     "status" text NOT NULL DEFAULT 'posted',
     "task_id" text,
     "error" text DEFAULT '',
     "created_at" timestamp with time zone DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS "clip_publishes_clip_idx" ON "clip_publishes" ("clip_id")`,
  // candidates: brand/channel X handle for "tag the speaker AND the brand" (0016)
  `ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "channel_x_handle" text DEFAULT ''`,
  // verified X-handle cache for automatic tag resolution (0017)
  `CREATE TABLE IF NOT EXISTS "resolved_handles" (
     "id" serial PRIMARY KEY NOT NULL,
     "kind" text NOT NULL,
     "name" text NOT NULL,
     "handle" text NOT NULL DEFAULT '',
     "confidence" real DEFAULT 0,
     "evidence" text DEFAULT '',
     "created_at" timestamp with time zone DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "resolved_handles_name_kind_idx" ON "resolved_handles" ("name", "kind")`,
  // candidates: verified entity tags cc'd in posts (0018)
  `ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "extra_tags" text DEFAULT '[]'`,
  // figures: DB-backed tracked-people table
  `CREATE TABLE IF NOT EXISTS "figures" (
     "id" serial PRIMARY KEY NOT NULL,
     "name" text NOT NULL,
     "x_handle" text NOT NULL,
     "org" text DEFAULT '',
     "role" text DEFAULT '',
     "priority" integer DEFAULT 2,
     "youtube_channel_id" text,
     "created_at" timestamp with time zone DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "figures_handle_idx" ON "figures" ("x_handle")`,
];

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ ok: false, error: "DATABASE_URL is not set" }, { status: 500 });
  }
  const results: { statement: string; ok: boolean; error?: string }[] = [];
  for (const stmt of STATEMENTS) {
    try {
      await db().execute(sql.raw(stmt));
      results.push({ statement: stmt.replace(/\s+/g, " ").trim().slice(0, 80), ok: true });
    } catch (e) {
      results.push({ statement: stmt.replace(/\s+/g, " ").trim().slice(0, 80), ok: false, error: (e as Error).message });
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  return NextResponse.json({
    ok: failed === 0,
    applied: results.length - failed,
    failed,
    results,
    next: "Now open /api/admin/diagnostics to confirm everything is green, then run Scout.",
  }, { status: failed === 0 ? 200 : 500 });
}
