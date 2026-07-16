import { eq, sql } from "drizzle-orm";
import { db, candidates, summonRequests } from "@/lib/db";
import { requireScoutEnv, requireXEnv, requireXReadEnv } from "./env";
import { getSettings, updateSummonState } from "@/lib/settings";
import { MAX_CONCURRENT_RENDERS } from "./config";
import { opusclipCreateProject } from "./opusclip";
import {
  allowedSummonUrl, fetchVideoDurationS, MIN_SUMMON_VIDEO_S, screenSummonTarget,
} from "./clipSafety";
import { xPublisher } from "./publishing";
import { reportHealth } from "@/lib/xbot/health";
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
  // The poll reports to the health ledger: a failing mentions endpoint (rate limit, wrong API
  // tier, bad bearer) must show up on /replies and diagnostics — not vanish into a cron 500.
  const cfg = await getSettings();
  let mentions: Awaited<ReturnType<typeof fetchMentions>>["mentions"];
  try {
    let botUserId = cfg.xBotUserId;
    if (!botUserId) {
      botUserId = await getBotUserId();
      await updateSummonState({ xBotUserId: botUserId });
    }
    ({ mentions } = await fetchMentions(botUserId, cfg.summonSinceId));
    await reportHealth("summon", true);
  } catch (e) {
    await reportHealth("summon", false, (e as Error).message);
    await logEvent("error", `Summon mention poll failed: ${(e as Error).message}`);
    throw e;
  }
  if (mentions.length) {
    await logEvent("run", `Summon poll: ${mentions.length} new mention(s) of the bot`);
  }

  // Summon shares OpusClip's concurrent-render budget with Scout. Only take as many mentions
  // as there are free slots; the cursor stops before unhandled ones, so they're retried next
  // poll (5 min) instead of failing the create call and dropping the user's request.
  const inFlight = Number(
    (await database.select({ n: sql<number>`count(*)::int` })
      .from(candidates).where(eq(candidates.status, "rendering")))[0]?.n ?? 0,
  );
  let slots = Math.max(0, MAX_CONCURRENT_RENDERS - inFlight);

  // Process oldest-first and advance the cursor only past mentions we actually handle, so a
  // burst larger than the per-run cap is resumed next poll instead of being skipped.
  const ascending = [...mentions].reverse();
  let cursor: string | null = cfg.summonSinceId ?? null;
  let processed = 0;
  for (const m of ascending) {
    if (processed >= MAX_REPLIES_PER_RUN) break;
    if (slots <= 0) break; // no free render slot — leave this mention for the next poll
    cursor = m.tweetId; // committing to a decision on this mention now

    // Dedup by mention id — never reply to the same summon twice.
    const seen = await database
      .select({ id: summonRequests.id })
      .from(summonRequests)
      .where(eq(summonRequests.tweetId, m.tweetId))
      .limit(1);
    if (seen.length) continue;

    // No video URL in the mention or its parent: tell the user HOW to summon instead of
    // silently ignoring them (a bare "@videoclipthis" in a text thread is the #1 first try).
    if (!m.targetUrl) {
      await database.insert(summonRequests).values({
        tweetId: m.tweetId, requester: m.requester, targetUrl: "", status: "no_video",
      });
      try {
        await xPublisher().publish({
          clipUrl: "",
          postText: `I don't see a video to clip 👀 Tag me in a reply to a post that links a YouTube or Vimeo video (5+ min) and I'll pull out the best moment 🎬`,
          costUsd: 0, durationS: 0,
        }, m.tweetId);
        await logEvent("skipped", `Summon from @${m.requester} had no video URL — replied with instructions`);
      } catch (e) {
        await logEvent("error", `Summon no-video reply failed for @${m.requester}: ${(e as Error).message}`);
      }
      processed++; // the reply counts against the per-run reply budget
      continue;
    }

    // Gates BEFORE spending a render, cheapest first. Summon is an open door (any X user,
    // any URL): (1) allowlisted video hosts only; (2) source must be long enough to contain
    // a clippable moment — too short gets a friendly reply saying so; (3) the request+video
    // title are screened for adult/unsafe content (rejected silently — don't teach abusers
    // the filter).
    const hostCheck = allowedSummonUrl(m.targetUrl);
    if (!hostCheck.allow) {
      await database.insert(summonRequests).values({
        tweetId: m.tweetId, requester: m.requester, targetUrl: m.targetUrl, status: "rejected",
      });
      await logEvent("skipped", `Summon rejected (@${m.requester}): ${hostCheck.reason}`);
      // Honest-user case (X-native videos are the #1 thing people tag) — explain the rule
      // publicly, unlike safety rejections which stay silent.
      try {
        await xPublisher().publish({
          clipUrl: "",
          postText: `Right now I can only clip videos hosted on YouTube or Vimeo (5+ min) — X-native videos aren't supported yet. Tag me under a post with a YouTube link and I'll pull out the best moment 🎬`,
          costUsd: 0, durationS: 0,
        }, m.tweetId);
      } catch (e) {
        await logEvent("error", `Summon unsupported-host reply failed for @${m.requester}: ${(e as Error).message}`);
      }
      processed++; // the reply counts against the per-run reply budget
      continue;
    }

    const durationS = await fetchVideoDurationS(m.targetUrl);
    if (durationS != null && durationS < MIN_SUMMON_VIDEO_S) {
      await database.insert(summonRequests).values({
        tweetId: m.tweetId, requester: m.requester, targetUrl: m.targetUrl, status: "rejected",
      });
      try {
        await xPublisher().publish({
          clipUrl: "",
          postText: `Sorry — I can only clip videos that are at least ${Math.round(MIN_SUMMON_VIDEO_S / 60)} minutes long, and this one is ${Math.floor(durationS / 60)}m${String(durationS % 60).padStart(2, "0")}s. Tag me under a full talk, podcast, or keynote and I'll pull out the best moment 🎬`,
          costUsd: 0, durationS: 0,
        }, m.tweetId);
        await logEvent("skipped", `Summon rejected (@${m.requester}): video too short (${durationS}s) — told them the ${MIN_SUMMON_VIDEO_S / 60}-min minimum`);
      } catch (e) {
        await logEvent("error", `Summon too-short reply failed for @${m.requester}: ${(e as Error).message}`);
      }
      processed++; // the reply counts against the per-run reply budget
      continue;
    }

    const screen = await screenSummonTarget(m.targetUrl, m.text);
    if (!screen.allow) {
      await database.insert(summonRequests).values({
        tweetId: m.tweetId, requester: m.requester, targetUrl: m.targetUrl, status: "rejected",
      });
      await logEvent("skipped", `Summon rejected (@${m.requester}): ${screen.reason}`);
      continue;
    }

    const [cand] = await database.insert(candidates).values({
      source: "summon", url: m.targetUrl, videoId: m.targetUrl,
      title: `Summoned by @${m.requester}`, speaker: m.requester, status: "found",
    }).returning();
    const [req] = await database.insert(summonRequests).values({
      tweetId: m.tweetId, requester: m.requester, targetUrl: m.targetUrl,
      status: "received", candidateId: cand.id,
    }).returning();

    // The safety gate passed; skip only the RELEVANCE gate (a human asked): submit the render.
    try {
      const projectId = await opusclipCreateProject(m.targetUrl, opusKey, opusBase, {}, cfg.opusBrandTemplateId);
      await database.update(candidates)
        .set({ status: "rendering", opusProjectId: projectId, renderStartedAt: new Date() })
        .where(eq(candidates.id, cand.id));
      await database.update(summonRequests).set({ status: "clipped" }).where(eq(summonRequests.id, req.id));
      await logEvent("rendering", `Summon: rendering a clip of ${m.targetUrl} for @${m.requester}`, "summon_requests", req.id);
      // Instant acknowledgment so the requester knows it's working — the clip itself takes
      // minutes to render and arrives as a second reply. Best-effort: an ack failure must
      // not fail the render that was just submitted.
      try {
        await xPublisher().publish({
          clipUrl: "",
          postText: `🎬 On it — watching the video and pulling out the best moment. I'll reply with the clip in a few minutes.`,
          costUsd: 0, durationS: 0,
        }, m.tweetId);
      } catch (e) {
        await logEvent("error", `Summon ack reply failed for @${m.requester}: ${(e as Error).message}`, "summon_requests", req.id);
      }
      processed++;
      slots--;
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
