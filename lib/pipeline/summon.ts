import { eq } from "drizzle-orm";
import { db, candidates, clips, summonRequests } from "@/lib/db";
import { requireScoutEnv, requireXEnv, requireXReadEnv } from "./env";
import { getSettings, updateSummonState } from "@/lib/settings";
import { opusclipSelector } from "./selection";
import { opusclipClipper } from "./production";
import { xPublisher } from "./publishing";
import { logEvent } from "./runScout";
import { fetchMentions, getBotUserId } from "./xread";
import type { DetectedCandidate } from "./types";

export interface SummonResult {
  processed: number;
}

// Never fire off more than this many summon replies in a single poll — guards against a
// thundering herd of mentions (and the X policy "don't be spammy" line).
const MAX_REPLIES_PER_RUN = 5;

/** Reactive mode: clip whatever a user tags @videoclipthis under, and reply in-thread. */
export async function runSummon(): Promise<SummonResult> {
  requireScoutEnv();
  requireXEnv();
  requireXReadEnv();
  const database = db();
  const selector = opusclipSelector(process.env.OPUSCLIP_API_KEY ?? "", process.env.ANTHROPIC_API_KEY ?? "");
  const clipper = opusclipClipper(process.env.OPUSCLIP_API_KEY ?? "", process.env.OPUSCLIP_API_BASE ?? "");
  const publisher = xPublisher();

  // Resolve + cache the bot's own user id, then poll mentions since the last processed one.
  const cfg = await getSettings();
  let botUserId = cfg.xBotUserId;
  if (!botUserId) {
    botUserId = await getBotUserId();
    await updateSummonState({ xBotUserId: botUserId });
  }
  const { mentions } = await fetchMentions(botUserId, cfg.summonSinceId);

  // Process oldest-first and advance the cursor only past mentions we actually handle, so a
  // burst larger than the per-run cap is resumed next poll instead of being skipped.
  const ascending = [...mentions].reverse();
  let cursor: string | null = cfg.summonSinceId ?? null;
  let processed = 0;
  for (const m of ascending) {
    if (processed >= MAX_REPLIES_PER_RUN) break;
    cursor = m.tweetId; // committing to a decision on this mention now
    if (!m.targetUrl) continue; // nothing to clip — no video URL in the mention or its parent

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

  // Advance the poll cursor so the next run only sees newer mentions.
  if (cursor && cursor !== cfg.summonSinceId) await updateSummonState({ summonSinceId: cursor });
  return { processed };
}
