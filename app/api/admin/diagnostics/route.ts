import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { MIN_CLIP_POST_GAP_MIN } from "@/lib/pipeline/config";
import { EDITORIAL_MIN_SCORE } from "@/lib/pipeline/editorial";
import { hasXEnv } from "@/lib/pipeline/env";
import { CLIP_REVIEW_TTL_H } from "@/lib/pipeline/render";
import { failingComponents, fetchXUsage, getXbotHealth } from "@/lib/xbot/health";
import { effectiveCaps, inLockFreeze } from "@/lib/xbot/limits";
import { getXbotSettings } from "@/lib/xbot/settings";

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
  ["settings", "search_topics"],
  ["settings", "search_offset"],
  ["settings", "summon_since_id"],
  ["settings", "x_bot_user_id"],
  ["settings", "figure_search_at"],
  ["candidates", "opus_project_id"],
  ["candidates", "submit_attempts"],
  ["candidates", "channel_x_handle"],
  ["clips", "fail_reason"],
  ["clips", "opus_clip_id"],
  ["xbot_tweets", "view_count"],
  // The editorial gate (0019). candidates.transcript is the one that bites hardest: runScout
  // inserts it OUTSIDE the per-candidate try/catch, so if it's missing the INSERT throws out of
  // the discovery loop and the entire run dies — no scoring, no renders collected, no posts.
  // This list went stale once already and diagnostics reported a clean schema while scout was
  // failing on exactly these columns. Every new column in lib/db/schema.ts belongs here too.
  ["candidates", "transcript"],
  ["clips", "follow_up_text"],
  ["clips", "pull_quote"],
  ["clips", "editorial_score"],
  ["clips", "editorial_note"],
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

  // 2. Database connectivity + schema drift. `haveCols` is shared with the posting-path check
  // below, which must not query a column that doesn't exist yet.
  const haveCols = new Set<string>();
  try {
    const cols: any = await db().execute(
      sql`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
    );
    const rows: any[] = cols.rows ?? cols;
    for (const r of rows) haveCols.add(`${r.table_name}.${r.column_name}`);
    const have = haveCols;
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

    // Render-submit failures need their own line in `problems`. The live OpusClip check below
    // reads GET /api/api-usage — the API RATE CAP, which is NOT the meter that bills a render.
    // The cap reported 89,722 credits remaining while every submit was answered 402
    // InsufficientCreditError, so `opusclip.ok: true` is not evidence that renders work. Before
    // this, those 402s appeared only in recentErrors: the verdict read clean through three days
    // of a pipeline that had rendered nothing at all.
    //
    // Matched on the "Render submit failed" message prefix that every submit-failure path in
    // runScout.ts emits — including the credit-wall branch, which keeps the prefix for this query.
    const submitFails: any = await db().execute(
      sql`SELECT
            count(*)::int AS n,
            count(*) FILTER (WHERE message ILIKE '%402%' OR message ILIKE '%InsufficientCredit%')::int AS credit_n,
            max(created_at) AS latest
          FROM events
          WHERE type = 'error'
            AND message LIKE 'Render submit failed%'
            AND created_at > now() - interval '24 hours'`,
    );
    const sf = (submitFails.rows ?? submitFails)[0] ?? {};
    const submitFailures24h = Number(sf.n ?? 0);
    const creditFailures24h = Number(sf.credit_n ?? 0);
    report.renderSubmit = {
      failures24h: submitFailures24h,
      creditFailures24h,
      lastFailureAt: sf.latest ?? null,
    };
    if (creditFailures24h > 0) {
      problems.push(
        `${creditFailures24h} render submit(s) refused in the last 24h for INSUFFICIENT OPUSCLIP CREDIT `
        + `— no new clips are being produced, so nothing can post no matter how healthy the rest of `
        + `the pipeline looks. Check the plan's remaining hours in the OpusClip dashboard; the `
        + `"opusclip" block below reads the API rate cap, which is a different meter and stays green `
        + `through this`,
      );
    } else if (submitFailures24h > 0) {
      problems.push(
        `${submitFailures24h} render submit(s) failed in the last 24h — no new clips are being `
        + `produced; see recentErrors for the reason`,
      );
    }
  } catch {
    /* covered by the database check above */
  }

  // 3b. THE POSTING PATH — "it hasn't posted in days, why?" answered by walking every gate a
  // clip passes through, in order, and naming the closed one. Several of these gates are silent
  // by design (a paced or capped clip logs nothing, and a missing X token makes the drain return
  // 0 without a word), which is exactly why they need to be reported somewhere.
  try {
    const cfg = await getSettings();
    const clipCounts: any = await db().execute(
      sql`SELECT status, count(*)::int AS n FROM clips GROUP BY status ORDER BY n DESC`,
    );
    const byStatus: Record<string, number> = {};
    for (const r of (clipCounts.rows ?? clipCounts)) byStatus[String(r.status)] = Number(r.n);

    const last: any = await db().execute(
      sql`SELECT posted_at, kind FROM clips WHERE status = 'posted' AND posted_at IS NOT NULL
          ORDER BY posted_at DESC LIMIT 1`,
    );
    const lastPostedAt = (last.rows ?? last)[0]?.posted_at ?? null;
    const hoursSince = lastPostedAt
      ? Math.round((Date.now() - new Date(lastPostedAt).getTime()) / 36e5)
      : null;

    const today: any = await db().execute(
      sql`SELECT count(*)::int AS n FROM clips
          WHERE status = 'posted' AND kind = 'scout' AND posted_at >= date_trunc('day', now() AT TIME ZONE 'utc')`,
    );
    const postedTodayScout = Number((today.rows ?? today)[0]?.n ?? 0);

    const expired: any = await db().execute(
      sql`SELECT count(*)::int AS n FROM clips WHERE status = 'expired' AND created_at >= now() - interval '48 hours'`,
    );

    // Only reachable once 0019 is applied — before that these columns don't exist.
    let vetoed: number | null = null;
    if (haveCols.has("clips.editorial_score")) {
      const v: any = await db().execute(
        sql`SELECT count(*)::int AS n FROM clips
            WHERE editorial_score IS NOT NULL AND editorial_score < ${EDITORIAL_MIN_SCORE}
              AND created_at >= now() - interval '48 hours'`,
      );
      vetoed = Number((v.rows ?? v)[0]?.n ?? 0);
    }

    report.posting = {
      lastPostedAt, hoursSinceLastPost: hoursSince,
      clipsByStatus: byStatus,
      postedTodayScout, dailyClipCap: cfg.dailyClipCap,
      minGapMinutes: MIN_CLIP_POST_GAP_MIN,
      paused: cfg.paused, autonomy: cfg.autonomy,
      xPostingConfigured: hasXEnv(),
      cronSecretSet: Boolean(process.env.CRON_SECRET?.trim()),
      reviewTtlHours: CLIP_REVIEW_TTL_H,
      editorialMinScore: EDITORIAL_MIN_SCORE,
      vetoedLast48h: vetoed,
      expiredLast48h: Number((expired.rows ?? expired)[0]?.n ?? 0),
    };

    // Gates that produce ZERO posts, in the order a clip meets them.
    if (cfg.paused) {
      problems.push("settings.paused is ON — Scout skips every run, so nothing new is ever clipped or posted");
    }
    if (!process.env.CRON_SECRET?.trim()) {
      problems.push("CRON_SECRET is not set — every /api/cron/* route returns 503, so nothing runs unattended (manual 'Run Scout now' still works)");
    }
    if (!hasXEnv()) {
      problems.push("X posting tokens are missing (X_API_KEY/X_API_SECRET/X_ACCESS_TOKEN/X_ACCESS_SECRET) — clips render and queue as 'approved' but the drain returns silently without posting");
    }
    if (cfg.autonomy !== "auto") {
      problems.push(`autonomy is "${cfg.autonomy}", not "auto" — every clip parks in pending_review and is DISCARDED after ${CLIP_REVIEW_TTL_H}h if nobody approves it. Switch to auto in Settings, or approve clips within the TTL`);
    }
    if ((byStatus.approved ?? 0) > 0 && hoursSince !== null && hoursSince > 24) {
      problems.push(`${byStatus.approved} clip(s) stuck in 'approved' (ready to post) but nothing has posted for ${hoursSince}h — the publish step is failing; check clips.fail_reason and recentErrors`);
    }
    if ((byStatus.failed ?? 0) > 0) {
      problems.push(`${byStatus.failed} clip(s) in 'failed' — paid renders whose publish errored. Retry them from /posts`);
    }
    if (vetoed !== null && vetoed > 0 && postedTodayScout === 0) {
      problems.push(`the editor vetoed ${vetoed} clip(s) in the last 48h and nothing posted today — EDITORIAL_MIN_SCORE=${EDITORIAL_MIN_SCORE} may be set too high for your sources`);
    }
  } catch (e) {
    report.posting = { error: (e as Error).message };
    problems.push(`posting-path check failed: ${(e as Error).message}`);
  }

  // 4. Live OpusClip key/quota check. This proves the KEY works and reports the API rate cap.
  // It does NOT report the plan's render balance — the two are separate meters, and only the
  // renderSubmit counters above can tell you renders are actually being accepted. Labelled in the
  // response so nobody reads a healthy `remaining` as "renders are fine" again.
  if (process.env.OPUSCLIP_API_KEY) {
    const base = (process.env.OPUSCLIP_API_BASE ?? "https://api.opus.pro").replace(/\/$/, "");
    const r = await timed(() => fetch(`${base}/api/api-usage?q=mine`, {
      headers: { authorization: `Bearer ${process.env.OPUSCLIP_API_KEY}`, accept: "application/json" },
    }));
    report.opusclip = {
      ...r,
      meter: "API rate cap only — NOT the plan's render balance. Submits can fail 402 "
        + "InsufficientCreditError while this reads healthy; see renderSubmit for the truth.",
    };
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

  // 7. XBot: component health (why did it stop), like-supply backlog, and X read-budget usage.
  try {
    const health = await getXbotHealth();
    const failing = failingComponents(health);
    const backlog: any = await db().execute(
      sql`SELECT count(*)::int AS n FROM xbot_tweets WHERE liked = false AND found_via IN ('roster','inbound','search')`,
    );
    const settings = await getXbotSettings();
    report.xbot = {
      health,
      unlikedBacklog: Number((backlog.rows ?? backlog)[0]?.n ?? 0),
      usage: await fetchXUsage(),
      lock: settings.lockDetectedAt
        ? { detectedAt: settings.lockDetectedAt, reason: settings.lockReason, inFreeze: inLockFreeze(settings) }
        : null,
      effectiveCaps: await effectiveCaps(settings),
    };
    for (const f of failing) {
      problems.push(`xbot ${f.component} failing (${f.consecutiveErrors}×): ${f.lastError}`);
    }
    if (settings.lockDetectedAt) {
      problems.push(`X ACCOUNT LOCK detected ${settings.lockDetectedAt.toISOString()} — bot auto-paused; verify on x.com`);
    }
  } catch (e) {
    report.xbot = { error: (e as Error).message };
  }

  report.problems = problems;
  report.verdict = problems.length === 0
    ? "All checks passed — run Scout and clips should flow into the review queue."
    : `${problems.length} problem(s) found — see "problems" below.`;
  return NextResponse.json(report, { status: 200 });
}
