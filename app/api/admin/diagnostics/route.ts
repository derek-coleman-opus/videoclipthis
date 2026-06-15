import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// One-shot health check for the whole deployment (admin basic-auth via middleware).
// Open in a browser: /api/admin/diagnostics — every dependency reports ok/error with the
// exact reason, so "it's not working" becomes a precise, self-served diagnosis. No SQL, no CLI.

// Columns/tables the running code REQUIRES. Missing ones (schema drift from hand-applied SQL)
// make queries throw and take the whole app down — fix with GET /api/admin/migrate.
const REQUIRED_COLUMNS: [string, string][] = [
  ["settings", "niche"],
  ["settings", "watch_channels"],
  ["settings", "opus_brand_template_id"],
  ["settings", "summon_since_id"],
  ["settings", "x_bot_user_id"],
  ["settings", "figure_search_at"],
  ["candidates", "opus_project_id"],
];
const REQUIRED_TABLES = ["candidates", "clips", "settings", "runs", "events", "summon_requests", "figures"];

const ENV_KEYS = [
  "DATABASE_URL", "YOUTUBE_API_KEY", "ANTHROPIC_API_KEY", "OPUSCLIP_API_KEY",
  "X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET", "X_BEARER_TOKEN",
];

async function timed(fetcher: () => Promise<Response>): Promise<{ ok: boolean; status: number; detail: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetcher();
    const body = await res.text();
    return { ok: res.ok, status: res.status, detail: body.slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, detail: (e as Error).message };
  } finally {
    clearTimeout(t);
  }
}

export async function GET() {
  const report: Record<string, unknown> = { ts: new Date().toISOString() };
  const problems: string[] = [];

  // 1. Env presence (booleans only — never echo secret values).
  report.env = Object.fromEntries(ENV_KEYS.map((k) => [k, Boolean(process.env[k]?.trim())]));
  for (const k of ["DATABASE_URL", "YOUTUBE_API_KEY", "ANTHROPIC_API_KEY", "OPUSCLIP_API_KEY"]) {
    if (!process.env[k]?.trim()) problems.push(`env ${k} is not set`);
  }

  // 2. Database connectivity + schema drift.
  try {
    const cols: any = await db().execute(
      sql`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
    );
    const rows: any[] = cols.rows ?? cols;
    const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    const tables = new Set(rows.map((r) => r.table_name));
    const missingCols = REQUIRED_COLUMNS.filter(([t, c]) => !have.has(`${t}.${c}`)).map(([t, c]) => `${t}.${c}`);
    const missingTables = REQUIRED_TABLES.filter((t) => !tables.has(t));
    report.database = { connected: true, missingTables, missingColumns: missingCols };
    if (missingTables.length || missingCols.length) {
      problems.push(`schema drift — run GET /api/admin/migrate (missing: ${[...missingTables, ...missingCols].join(", ")})`);
    }
  } catch (e) {
    report.database = { connected: false, error: (e as Error).message };
    problems.push(`database: ${(e as Error).message}`);
  }

  // 3. Candidate pipeline state (where do videos get stuck?) + recent errors.
  try {
    const counts: any = await db().execute(
      sql`SELECT status, count(*)::int AS n FROM candidates GROUP BY status ORDER BY n DESC`,
    );
    report.candidatesByStatus = (counts.rows ?? counts);
    const errs: any = await db().execute(
      sql`SELECT message, created_at FROM events WHERE type = 'error' ORDER BY created_at DESC LIMIT 8`,
    );
    report.recentErrors = (errs.rows ?? errs);
  } catch {
    /* covered by the database check above */
  }

  // 4. Live OpusClip key/quota check.
  if (process.env.OPUSCLIP_API_KEY) {
    const base = (process.env.OPUSCLIP_API_BASE ?? "https://api.opus.pro").replace(/\/$/, "");
    const r = await timed(() => fetch(`${base}/api/api-usage?q=mine`, {
      headers: { authorization: `Bearer ${process.env.OPUSCLIP_API_KEY}`, accept: "application/json" },
    }));
    report.opusclip = r;
    if (!r.ok) problems.push(`OpusClip API: HTTP ${r.status} ${r.detail}`);
  }

  // 5. Live YouTube key/quota check (i18nLanguages = 1 quota unit).
  if (process.env.YOUTUBE_API_KEY) {
    const r = await timed(() => fetch(
      `https://www.googleapis.com/youtube/v3/i18nLanguages?part=snippet&hl=en&key=${process.env.YOUTUBE_API_KEY}`,
    ));
    report.youtube = r;
    if (!r.ok) problems.push(`YouTube API: HTTP ${r.status} ${r.detail.includes("quota") ? "quota exceeded" : r.detail}`);
  }

  // 6. Live Anthropic key check (models list is free).
  if (process.env.ANTHROPIC_API_KEY) {
    const r = await timed(() => fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" },
    }));
    report.anthropic = { ok: r.ok, status: r.status };
    if (!r.ok) problems.push(`Anthropic API: HTTP ${r.status} ${r.detail}`);
  }

  report.problems = problems;
  report.verdict = problems.length === 0
    ? "All checks passed — run Scout and clips should flow into the review queue."
    : `${problems.length} problem(s) found — see "problems" below.`;
  return NextResponse.json(report, { status: 200 });
}
