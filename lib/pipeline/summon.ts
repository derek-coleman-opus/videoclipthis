import { eq } from "drizzle-orm";
import { db, candidates, clips, summonRequests } from "@/lib/db";
import { requireScoutEnv, requireXEnv } from "./env";
import { opusclipSelector } from "./selection";
import { opusclipClipper } from "./production";
import { xPublisher } from "./publishing";
import { logEvent } from "./runScout";
import type { DetectedCandidate } from "./types";

export interface SummonResult {
  processed: number;
}

interface Mention {
  tweetId: string;
  requester: string;
  targetUrl: string;
}

// TODO-LIVE (§1.6): poll X mentions of @videoclipthis (v2 userMentionTimeline with since_id) and
// pull the target video URL from the mentioned/quoted/linked tweet.
async function fetchMentions(): Promise<Mention[]> {
  return [];
}

/** Reactive mode: clip whatever a user tags @videoclipthis under, and reply in-thread. */
export async function runSummon(): Promise<SummonResult> {
  requireScoutEnv();
  requireXEnv();
  const database = db();
  const selector = opusclipSelector(process.env.OPUSCLIP_API_KEY ?? "", process.env.ANTHROPIC_API_KEY ?? "");
  const clipper = opusclipClipper(process.env.OPUSCLIP_API_KEY ?? "", process.env.OPUSCLIP_API_BASE ?? "");
  const publisher = xPublisher();

  let processed = 0;
  for (const m of await fetchMentions()) {
    // Dedup by mention id — never reply to the same summon twice.
    const seen = await database
      .select({ id: summonRequests.id })
      .from(summonRequests)
      .where(eq(summonRequests.tweetId, m.tweetId))
      .limit(1);
    if (seen.length) continue;

    const d: DetectedCandidate = {
      source: "summon", url: m.targetUrl, videoId: m.targetUrl,
      title: `Summoned by @${m.requester}`,
    };
    const [cand] = await database.insert(candidates).values({
      source: "summon", url: d.url, videoId: d.videoId, title: d.title, status: "selected",
    }).returning();
    const [req] = await database.insert(summonRequests).values({
      tweetId: m.tweetId, requester: m.requester, targetUrl: m.targetUrl,
      status: "received", candidateId: cand.id,
    }).returning();

    // A human asked, so we skip the relevance gate (build plan §7).
    const moment = await selector.select(d);
    if (!moment) {
      await database.update(summonRequests).set({ status: "failed" }).where(eq(summonRequests.id, req.id));
      continue;
    }
    const produced = await clipper.produce(d, moment);
    const result = await publisher.publish(produced, m.tweetId);

    await database.insert(clips).values({
      candidateId: cand.id, startS: moment.startS, endS: moment.endS, hookCaption: moment.hookCaption,
      postText: produced.postText, clipUrl: produced.clipUrl, kind: "summon",
      status: "posted", xPostId: result.xPostId, replyTo: m.tweetId,
      costUsd: produced.costUsd, postedAt: new Date(),
    });
    await database.update(summonRequests)
      .set({ status: "replied" })
      .where(eq(summonRequests.id, req.id));
    await logEvent("replied", `Summon: replied to @${m.requester} with a clip of ${m.targetUrl}`, "summon_requests", req.id);
    processed++;
  }
  return { processed };
}
