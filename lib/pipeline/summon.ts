import { eq } from "drizzle-orm";
import { db, candidates, clips, summonRequests } from "@/lib/db";
import { isMock } from "./config";
import { mockSelector, opusclipSelector } from "./selection";
import { mockClipper, opusclipClipper } from "./production";
import { dryRunPublisher, xPublisher } from "./publishing";
import { logEvent } from "./runScout";
import type { DetectedCandidate } from "./types";

export interface SummonResult {
  processed: number;
  mock: boolean;
}

interface Mention {
  tweetId: string;
  requester: string;
  targetUrl: string;
}

// TODO-LIVE: poll X mentions of @videoclipthis (v2 userMentionTimeline with since_id) and pull the
// target video URL from the mentioned/quoted/linked tweet. See build plan §7.
async function fetchMentions(mock: boolean): Promise<Mention[]> {
  if (mock) {
    return [{ tweetId: "mock-mention-1", requester: "dev_curious", targetUrl: "https://youtu.be/DEMO123" }];
  }
  return [];
}

/** Reactive mode: clip whatever a user tags @videoclipthis under, and reply in-thread. */
export async function runSummon(): Promise<SummonResult> {
  const mock = isMock();
  const database = db();
  const selector = mock
    ? mockSelector
    : opusclipSelector(process.env.OPUSCLIP_API_KEY ?? "", process.env.ANTHROPIC_API_KEY ?? "");
  const clipper = mock
    ? mockClipper
    : opusclipClipper(process.env.OPUSCLIP_API_KEY ?? "", process.env.OPUSCLIP_API_BASE ?? "");
  const publisher = mock ? dryRunPublisher : xPublisher();

  let processed = 0;
  for (const m of await fetchMentions(mock)) {
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
      status: mock ? "pending_review" : "posted", xPostId: result.xPostId, replyTo: m.tweetId,
      costUsd: produced.costUsd, postedAt: mock ? null : new Date(),
    });
    await database.update(summonRequests)
      .set({ status: mock ? "clipped" : "replied" })
      .where(eq(summonRequests.id, req.id));
    await logEvent("replied", `Summon: replied to @${m.requester} with a clip of ${m.targetUrl}`, "summon_requests", req.id);
    processed++;
  }
  return { processed, mock };
}
