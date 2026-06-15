import { eq } from "drizzle-orm";
import { db, candidates, summonRequests } from "@/lib/db";
import { requireScoutEnv, requireXEnv, requireXReadEnv } from "./env";
import { getSettings, updateSummonState } from "@/lib/settings";
import { opusclipCreateProject } from "./opusclip";
import { collectRenders } from "./render";
import { logEvent } from "./events";
import { fetchMentions, getBotUserId } from "./xread";

export interface SummonResult {
  processed: number;
  collected: number;
}

// Never start more than this many summon renders in a single poll — guards against a
// thundering herd of mentions (and the X policy "don't be spammy" line).
const MAX_REPLIES_PER_RUN = 5;

/** Reactive mode: clip whatever a user tags @videoclipthis under, and reply in-thread.
 *  Two-phase like Scout: this submits the render and exits; collectRenders() (run here and at
 *  the top of every scout cycle) posts the reply once the clip is ready. */
export async function runSummon(): Promise<SummonResult> {
  requireScoutEnv();
  requireXEnv();
  requireXReadEnv();
  const database = db();
  const opusKey = process.env.OPUSCLIP_API_KEY ?? "";
  const opusBase = process.env.OPUSCLIP_API_BASE ?? "";

  // Collect first so finished renders (scout or summon) go out on the 5-min cadence.
  const collect = await collectRenders();

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

    const [cand] = await database.insert(candidates).values({
      source: "summon", url: m.targetUrl, videoId: m.targetUrl,
      title: `Summoned by @${m.requester}`, speaker: m.requester, status: "found",
    }).returning();
    const [req] = await database.insert(summonRequests).values({
      tweetId: m.tweetId, requester: m.requester, targetUrl: m.targetUrl,
      status: "received", candidateId: cand.id,
    }).returning();

    // A human asked, so we skip the relevance gate: straight to render submission.
    try {
      const projectId = await opusclipCreateProject(m.targetUrl, opusKey, opusBase, {}, cfg.opusBrandTemplateId);
      await database.update(candidates)
        .set({ status: "rendering", opusProjectId: projectId })
        .where(eq(candidates.id, cand.id));
      await database.update(summonRequests).set({ status: "clipped" }).where(eq(summonRequests.id, req.id));
      await logEvent("rendering", `Summon: rendering a clip of ${m.targetUrl} for @${m.requester}`, "summon_requests", req.id);
      processed++;
    } catch (e) {
      await database.update(candidates).set({ status: "failed" }).where(eq(candidates.id, cand.id));
      await database.update(summonRequests).set({ status: "failed" }).where(eq(summonRequests.id, req.id));
      await logEvent("error", `Summon render failed for @${m.requester}: ${(e as Error).message}`, "summon_requests", req.id);
    }
  }

  // Advance the poll cursor so the next run only sees newer mentions.
  if (cursor && cursor !== cfg.summonSinceId) await updateSummonState({ summonSinceId: cursor });
  return { processed, collected: collect.collected };
}
