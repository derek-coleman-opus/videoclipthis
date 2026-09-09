import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// THE SCHEMA THE RUNNING CODE REQUIRES, as idempotent DDL.
//
// Single source of truth for both the operator-run GET /api/admin/migrate and the automatic
// self-heal below. It used to live only in that route, which made applying it a manual browser
// step the operator had to remember AFTER every deploy — and the window between the deploy and
// that click is a total outage, because getSettings() selects the settings row by explicit column
// list and every entry point calls it. That window took production down three times (0019, 0020,
// and 0020 again where diagnostics reported healthy). Every statement uses IF NOT EXISTS, so it is
// safe to run repeatedly and safe to run concurrently from several serverless instances.
// (The XBot tables have their own bootstrap in scripts/xbot-schema-bootstrap.sql.)
export const MIGRATION_STATEMENTS: string[] = [
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
  // candidates: bounded paid-render submit attempts (0018). The OpusClip create POST is billed and
  // non-idempotent, so it is no longer retried at the HTTP layer — retries are counted here.
  `ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "submit_attempts" integer NOT NULL DEFAULT 0`,
  // candidates: collapse duplicate video_ids so the unique index below can be created. Only rows
  // with no clips are removed; see drizzle/0018 for the full reasoning.
  `DELETE FROM "candidates" c
     WHERE c."source" <> 'summon'
       AND NOT EXISTS (SELECT 1 FROM "clips" cl WHERE cl."candidate_id" = c."id")
       AND EXISTS (
         SELECT 1 FROM "candidates" o
         WHERE o."source" <> 'summon'
           AND o."video_id" = c."video_id"
           AND o."id" <> c."id"
           AND (EXISTS (SELECT 1 FROM "clips" cl2 WHERE cl2."candidate_id" = o."id") OR o."id" < c."id")
       )`,
  // candidates: hard backstop against paying OpusClip twice for the same video (0018). Scoped to
  // non-summon rows because summon stores the target URL in video_id and dedups by mention id.
  `CREATE UNIQUE INDEX IF NOT EXISTS "candidates_video_id_uniq"
     ON "candidates" ("video_id") WHERE "source" <> 'summon'`,
  // The editorial gate (0019): the editor judges a finished render before it posts, writes the
  // verbatim pull quote used as the hook, and the source link moves to an in-thread follow-up.
  // candidates.transcript is what makes the quote possible — the editor runs when the render
  // lands, long after discovery, so the speaker's words have to be persisted.
  `ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "transcript" text DEFAULT ''`,
  `ALTER TABLE "clips" ADD COLUMN IF NOT EXISTS "follow_up_text" text DEFAULT ''`,
  `ALTER TABLE "clips" ADD COLUMN IF NOT EXISTS "pull_quote" text DEFAULT ''`,
  // NULL editorial_score = the editor did not run; that reads as "no opinion", never a rejection.
  `ALTER TABLE "clips" ADD COLUMN IF NOT EXISTS "editorial_score" integer`,
  `ALTER TABLE "clips" ADD COLUMN IF NOT EXISTS "editorial_note" text DEFAULT ''`,
  // Audience profiles (0020): one switch that moves the scorer, curator, editor AND discovery to a
  // different reader. Defaults reproduce the pre-profile AI/developer behavior exactly, so applying
  // this migration alone changes nothing until a profile is selected in the admin.
  `ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "active_profile" text NOT NULL DEFAULT 'ai-developer'`,
  // Per-profile snapshot of edited fields, so switching lanes and back does not lose hand-tuned
  // topics or channels. JSON keyed by profile key; '{}' means "no profile has been customized".
  `ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "profile_overrides" text NOT NULL DEFAULT '{}'`,
  `ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "curation_brief" text NOT NULL DEFAULT ''`,
];

/** True for statements that only ADD schema and can never touch a row: safe to run unattended.
 *
 *  The full set also contains two row-mutating statements, and neither may run as a side effect of
 *  a read: a `DELETE FROM candidates` that de-duplicates rows before the 0018 unique index, and an
 *  `UPDATE xbot_settings` that clamps the daily caps — which would silently undo caps the operator
 *  raised on purpose. Fixing the schema so queries stop throwing is the heal's whole job; changing
 *  data is a separate, deliberate act and stays behind GET /api/admin/migrate. */
function isAdditiveDDL(stmt: string): boolean {
  const s = stmt.trim();
  if (/^ALTER TABLE .* ADD COLUMN IF NOT EXISTS/is.test(s)) return true;
  if (/^CREATE TABLE IF NOT EXISTS/is.test(s)) return true;
  if (/^CREATE (UNIQUE )?INDEX IF NOT EXISTS/is.test(s)) return true;
  return false;
}

/** What the automatic self-heal applies — the additive subset, in the original order. */
export const AUTO_HEAL_STATEMENTS: string[] = MIGRATION_STATEMENTS.filter(isAdditiveDDL);

export interface MigrationResult {
  statement: string;
  ok: boolean;
  error?: string;
}

/** Apply statements, reporting per-statement outcomes rather than failing on the first.
 *  Defaults to the full set (the operator endpoint); the self-heal passes the additive subset. */
export async function applyMigrations(
  statements: string[] = MIGRATION_STATEMENTS,
): Promise<MigrationResult[]> {
  const results: MigrationResult[] = [];
  for (const stmt of statements) {
    try {
      await db().execute(sql.raw(stmt));
      results.push({ statement: stmt.replace(/\s+/g, " ").trim().slice(0, 80), ok: true });
    } catch (e) {
      results.push({
        statement: stmt.replace(/\s+/g, " ").trim().slice(0, 80),
        ok: false,
        error: (e as Error).message,
      });
    }
  }
  return results;
}

/** Postgres 42703 = undefined_column. The message form is matched too because the driver does not
 *  always surface `code` on a wrapped error. */
export function isMissingColumnError(e: unknown): boolean {
  const err = e as { code?: string; message?: string; cause?: { code?: string } };
  if (err?.code === "42703" || err?.cause?.code === "42703") return true;
  return /column .* does not exist/i.test(err?.message ?? String(e));
}

// One heal per process. Concurrent callers await the same promise instead of each running the DDL,
// and a completed heal is not repeated — so a genuinely missing table (which this cannot fix)
// cannot turn into an ALTER storm on every request.
let healing: Promise<void> | null = null;

/** What the last heal in this process did. Vercel logs are the only other record of an automatic
 *  heal, and nobody reads those until they already suspect a problem — so diagnostics reports this
 *  instead. A heal that FAILED is the case that matters: the deployment is then still down for the
 *  same reason it was before, and the most likely cause (the DATABASE_URL role lacking ALTER) is
 *  invisible from every other surface. */
export interface HealAttempt {
  at: string;
  applied: number;
  failed: MigrationResult[];
}
let lastHeal: HealAttempt | null = null;

/** The last automatic heal attempt in this process, or null if none has run. Note this is
 *  per-process: on serverless, a null here does not prove no heal ever ran, only that this
 *  instance has not needed one. */
export function lastHealAttempt(): HealAttempt | null {
  return lastHeal;
}

/** Bring the database up to the code's expectations, at most once per process.
 *
 *  Called from the read path when a query fails on a missing column, so it costs nothing in the
 *  normal case: no startup DDL, no per-request check, nothing added to Neon's compute burn (see
 *  #49) unless the schema is actually behind. */
export function ensureSchema(): Promise<void> {
  if (!healing) {
    healing = (async () => {
      const results = await applyMigrations(AUTO_HEAL_STATEMENTS);
      const failed = results.filter((r) => !r.ok);
      lastHeal = {
        at: new Date().toISOString(),
        applied: results.length - failed.length,
        failed,
      };
      // Do not throw: the caller retries its own query and surfaces the real error if the heal
      // did not help. A failing statement here is usually a permission problem, and reporting it
      // as the app's error would bury the actual cause. It is recorded above so
      // /api/admin/diagnostics can name it instead of leaving it in the Vercel logs.
      if (failed.length) {
        console.error("[ensureSchema] %d statement(s) failed", failed.length, failed.slice(0, 5));
      }
    })();
  }
  return healing;
}
