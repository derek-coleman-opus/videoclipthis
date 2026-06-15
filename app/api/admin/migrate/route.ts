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
  `ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "summon_since_id" text`,
  `ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "x_bot_user_id" text`,
  `ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "figure_search_at" timestamp with time zone`,
  // candidates: OpusClip project id for two-phase rendering
  `ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "opus_project_id" text`,
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
