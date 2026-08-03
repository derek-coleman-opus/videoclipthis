import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db, candidates, clips, events } from "@/lib/db";
import { requireXReadEnv } from "./env";
import { fetchPublicMetrics, didHandleReshare } from "./xread";

export interface FeedbackResult {
  updated: number;
  newReshares: number;
}

/** Refresh metrics on posted clips + record new speaker reshares (the credit-first loop's signal). */
export async function runFeedback(): Promise<FeedbackResult> {
  requireXReadEnv();
  const database = db();
  // Pull posted clips with their candidate's speaker handle (needed for reshare detection).
  const posted = await database
    .select({
      id: clips.id,
      xPostId: clips.xPostId,
      resharedBySpeaker: clips.resharedBySpeaker,
      speakerHandle: candidates.speakerHandle,
    })
    .from(clips)
    .innerJoin(candidates, eq(clips.candidateId, candidates.id))
    .where(and(eq(clips.status, "posted"), isNotNull(clips.xPostId)));

  const ids = posted.map((c) => c.xPostId as string);
  const metrics = await fetchPublicMetrics(ids);

  let updated = 0;
  let newReshares = 0;
  for (const c of posted) {
    const m = metrics.get(c.xPostId as string);
    if (!m) continue;
    const wasReshared = c.resharedBySpeaker ?? false;

    // Only spend a reshare lookup when it could flip the flag and the post actually has
    // retweets/quotes to inspect.
    let reshared = wasReshared;
    if (!wasReshared && c.speakerHandle && (m.retweets > 0 || m.quotes > 0)) {
      reshared = await didHandleReshare(c.xPostId as string, c.speakerHandle);
    }

    await database.update(clips)
      .set({ views: m.views, resharedBySpeaker: reshared })
      .where(eq(clips.id, c.id));
    updated++;

    if (reshared && !wasReshared) {
      newReshares++;
      await database.insert(events).values({
        type: "posted",
        message: `🎉 Speaker reshared a clip (post ${c.xPostId}) — ${m.views.toLocaleString()} views`,
        refTable: "clips",
        refId: c.id,
      });
    }
  }
  return { updated, newReshares };
}

/** Close the loop the account was missing: `clips.views` was written on every cycle and read by
 *  nothing. These are the pull quotes from the best-performing posts, handed to the editor
 *  (editorial.ts) as calibration so "what worked here before" shapes what ships next.
 *
 *  Reshared clips outrank raw view counts — a reshare by the speaker is the signal the whole
 *  credit-first model is built to earn. Cheap enough to call per collect cycle. */
export async function topPullQuotes(limit = 5): Promise<string[]> {
  try {
    const rows = await db()
      .select({ quote: clips.pullQuote, views: clips.views, reshared: clips.resharedBySpeaker })
      .from(clips)
      .where(and(eq(clips.status, "posted"), isNotNull(clips.pullQuote)))
      .orderBy(desc(clips.resharedBySpeaker), desc(clips.views))
      .limit(limit);
    return rows.map((r) => (r.quote ?? "").trim()).filter(Boolean);
  } catch {
    // Calibration is a nice-to-have; never let it break a collect cycle.
    return [];
  }
}

/** Feed performance back into ranking: speakers whose clips were reshared earn a small score boost. */
export async function reshareBoost(handle?: string): Promise<number> {
  if (!handle) return 0;
  const rows = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(clips)
    .innerJoin(candidates, eq(clips.candidateId, candidates.id))
    .where(and(eq(candidates.speakerHandle, handle), eq(clips.resharedBySpeaker, true)));
  return Math.min(10, Number(rows[0]?.n ?? 0) * 5);
}
