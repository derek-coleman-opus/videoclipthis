import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, candidates, clips, events } from "@/lib/db";
import { isMock } from "./config";

export interface FeedbackResult {
  updated: number;
  newReshares: number;
  mock: boolean;
}

// TODO-LIVE: fetch real X metrics — GET /2/tweets?ids=...&tweet.fields=public_metrics for views,
// and detect whether the speaker (candidate.speakerHandle) retweeted/quoted the post.
async function fetchMetrics(xPostId: string, mock: boolean): Promise<{ views: number; reshared: boolean }> {
  if (mock) {
    const seed = xPostId.split("").reduce((a, ch) => a + ch.charCodeAt(0), 0);
    return { views: 1000 + (seed % 9000) * 5, reshared: seed % 3 === 0 };
  }
  return { views: 0, reshared: false };
}

/** Refresh metrics on posted clips + record new speaker reshares (the credit-first loop's signal). */
export async function runFeedback(): Promise<FeedbackResult> {
  const mock = isMock();
  const database = db();
  const posted = await database
    .select()
    .from(clips)
    .where(and(eq(clips.status, "posted"), isNotNull(clips.xPostId)));

  let updated = 0;
  let newReshares = 0;
  for (const c of posted) {
    const m = await fetchMetrics(c.xPostId as string, mock);
    const wasReshared = c.resharedBySpeaker ?? false;
    await database.update(clips)
      .set({ views: m.views, resharedBySpeaker: m.reshared || wasReshared })
      .where(eq(clips.id, c.id));
    updated++;
    if (m.reshared && !wasReshared) {
      newReshares++;
      await database.insert(events).values({
        type: "posted",
        message: `🎉 Speaker reshared a clip (post ${c.xPostId}) — ${m.views.toLocaleString()} views`,
        refTable: "clips",
        refId: c.id,
      });
    }
  }
  return { updated, newReshares, mock };
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
