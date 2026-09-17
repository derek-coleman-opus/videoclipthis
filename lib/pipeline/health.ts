import { and, desc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { db, candidates, clips, events, runs } from "@/lib/db";
import { withSchemaHeal } from "@/lib/db/ensureSchema";

/** Hours without a COMPLETED run before the pipeline counts as stalled. Both crons fire every
 *  30 minutes, so anything past a couple of hours means runs are dying, not merely idle. */
const STALL_RUN_H = Number(process.env.STALL_RUN_H ?? 2);

/** Hours without a post before that is worth reporting — but only when something was actually
 *  waiting to go out. A quiet queue is not a fault; a full queue that never drains is. */
const STALL_POST_H = Number(process.env.STALL_POST_H ?? 24);

/** A render still in flight after this long is stuck: RENDER_TIMEOUT_H is 2h, so double that
 *  means the collector is not reclaiming it either. Stuck renders eat MAX_CONCURRENT_RENDERS
 *  slots, which silently halts all new submissions. */
const STUCK_RENDER_H = Number(process.env.STUCK_RENDER_H ?? 5);

export interface HealthReport {
  ok: boolean;
  stalled: boolean;
  ts: string;
  problems: string[];
  pipeline: Record<string, unknown>;
}

function hoursSince(v: unknown): number | null {
  if (!v) return null;
  return Math.round((Date.now() - new Date(v as string).getTime()) / 36e5);
}

/** THE ONE PLACE THAT DECIDES WHETHER THIS THING IS WORKING.
 *
 *  Written to answer a single question — "is the pipeline alive, and if not, why" — from data the
 *  pipeline already writes. Every outage in this project's history was invisible until someone
 *  noticed an absence of posts days later; the point here is that the absence reports itself.
 *
 *  Read-only and side-effect free, so it is safe to poll frequently and safe to expose behind a
 *  token. It deliberately returns no secrets: env keys appear as booleans, never values. */
export async function computeHealth(): Promise<HealthReport> {
  const problems: string[] = [];
  const pipeline: Record<string, unknown> = {};

  const database = db();
  const one = sql<number>`count(*)::int`;

  // Is the pipeline RUNNING at all? A run row with no finished_at is a run that died mid-flight.
  const lastFinished = (await withSchemaHeal(() => database
    .select().from(runs).where(isNotNull(runs.finishedAt)).orderBy(desc(runs.finishedAt)).limit(1)))[0];
  const lastStarted = (await database.select().from(runs).orderBy(desc(runs.startedAt)).limit(1))[0];
  const hSinceRun = hoursSince(lastFinished?.finishedAt);
  const unfinished = Number((await database.select({ n: one }).from(runs)
    .where(and(sql`${runs.finishedAt} IS NULL`, gte(runs.startedAt, new Date(Date.now() - 24 * 36e5)))))[0]?.n ?? 0);

  pipeline.lastRunFinishedAt = lastFinished?.finishedAt ?? null;
  pipeline.lastRunStartedAt = lastStarted?.startedAt ?? null;
  pipeline.hoursSinceFinishedRun = hSinceRun;
  pipeline.unfinishedRuns24h = unfinished;

  if (hSinceRun === null) {
    problems.push("no run has ever completed — the pipeline has never finished a cycle");
  } else if (hSinceRun >= STALL_RUN_H) {
    problems.push(
      `STALLED: no run has COMPLETED in ${hSinceRun}h (crons fire every 30 min). Runs are failing `
      + `part-way, not idling${unfinished ? ` — ${unfinished} run(s) started and never finished in the last 24h` : ""}`,
    );
  }

  // Renders stuck in flight silently halt submissions: they hold MAX_CONCURRENT_RENDERS slots.
  const stuckRenders = Number((await database.select({ n: one }).from(candidates)
    .where(and(
      eq(candidates.status, "rendering"),
      lt(candidates.renderStartedAt, new Date(Date.now() - STUCK_RENDER_H * 36e5)),
    )))[0]?.n ?? 0);
  pipeline.stuckRenders = stuckRenders;
  if (stuckRenders > 0) {
    problems.push(
      `${stuckRenders} render(s) stuck in flight for over ${STUCK_RENDER_H}h — these hold render `
      + `slots, so new submissions stop entirely once they fill up`,
    );
  }

  // Claims that were never released point at functions dying mid-work.
  const collecting = Number((await database.select({ n: one }).from(candidates)
    .where(eq(candidates.status, "collecting")))[0]?.n ?? 0);
  const posting = Number((await database.select({ n: one }).from(clips)
    .where(eq(clips.status, "posting")))[0]?.n ?? 0);
  pipeline.claimsHeld = { collecting, posting };

  // Posting: only a fault when something was actually queued to go out.
  const lastPost = (await database.select({ postedAt: clips.postedAt }).from(clips)
    .where(eq(clips.status, "posted")).orderBy(desc(clips.postedAt)).limit(1))[0];
  const hSincePost = hoursSince(lastPost?.postedAt);
  const approved = Number((await database.select({ n: one }).from(clips)
    .where(eq(clips.status, "approved")))[0]?.n ?? 0);
  const unverified = Number((await database.select({ n: one }).from(clips)
    .where(eq(clips.status, "unverified")))[0]?.n ?? 0);
  pipeline.lastPostedAt = lastPost?.postedAt ?? null;
  pipeline.hoursSincePost = hSincePost;
  pipeline.approvedWaiting = approved;
  pipeline.unverifiedClips = unverified;

  if (approved > 0 && (hSincePost === null || hSincePost >= STALL_POST_H)) {
    problems.push(
      `${approved} clip(s) approved and waiting but nothing has posted in `
      + `${hSincePost === null ? "ever" : `${hSincePost}h`} — the posting drain is not draining`,
    );
  }
  if (unverified > 0) {
    problems.push(
      `${unverified} clip(s) in 'unverified' — a publish outcome was ambiguous and needs a human to `
      + `check the timeline before retrying (never retried automatically, to avoid double-posting)`,
    );
  }

  // Where is work piling up?
  const byCandidate: Record<string, number> = {};
  for (const r of await database.select({ s: candidates.status, n: one }).from(candidates).groupBy(candidates.status)) {
    byCandidate[r.s] = Number(r.n);
  }
  const byClip: Record<string, number> = {};
  for (const r of await database.select({ s: clips.status, n: one }).from(clips).groupBy(clips.status)) {
    byClip[r.s] = Number(r.n);
  }
  pipeline.candidatesByStatus = byCandidate;
  pipeline.clipsByStatus = byClip;

  // Nothing queued to render AND nothing in flight = the supply side is empty, whatever the
  // reason (everything skipped, everything stranded). Worth naming: the pipeline looks calm.
  const renderable = (byCandidate.scored ?? 0) + (byCandidate.rendering ?? 0) + (byCandidate.collecting ?? 0);
  pipeline.renderableQueue = renderable;
  if (renderable === 0) {
    problems.push(
      "the render queue is EMPTY — nothing is scored, rendering or collecting, so no clip can be "
      + "produced no matter how healthy everything else looks. Either nothing passes the score "
      + "threshold or the backlog was stranded",
    );
  }

  // Recent errors, truncated. These are the pipeline's own messages, never credentials.
  const recent = await database.select({ message: events.message, createdAt: events.createdAt })
    .from(events).where(eq(events.type, "error")).orderBy(desc(events.createdAt)).limit(5);
  pipeline.recentErrors = recent.map((e) => ({
    message: (e.message ?? "").slice(0, 300),
    at: e.createdAt,
  }));

  const stalled = problems.some((p) => p.startsWith("STALLED"));
  return { ok: problems.length === 0, stalled, ts: new Date().toISOString(), problems, pipeline };
}
