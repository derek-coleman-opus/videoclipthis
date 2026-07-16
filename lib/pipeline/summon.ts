import { eq, sql } from "drizzle-orm";
import { db, candidates, summonRequests } from "@/lib/db";
import { requireScoutEnv, requireXEnv, requireXReadEnv } from "./env";
import { getSettings, updateSummonState } from "@/lib/settings";
import { MAX_CONCURRENT_RENDERS } from "./config";
import { opusclipCreateProject } from "./opusclip";
import {
  allowedSummonUrl, fetchOEmbedMeta, fetchVideoDurationS, MIN_SUMMON_VIDEO_S,
  screenSummonTarget, screenXVideoTarget, xStatusIdFromUrl,
} from "./clipSafety";
import { xPublisher } from "./publishing";
import { reportHealth } from "@/lib/xbot/health";
import { collectRenders } from "./render";
import { logEvent } from "./events";
import { slog } from "./util";
import { fetchMentions, fetchTweetVideo, getBotUserId, type MentionRaw, type TweetVideo } from "./xread";

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

    // Resolve + gate the target, cheapest check first. gateMention() decides one of three
    // outcomes: render it, reply with a reason (honest-user cases: no video, wrong host, too
    // short), or reject silently (safety — don't teach abusers the filter).
    const gate = await gateMention(m);
    if (gate.action !== "render") {
      const status = gate.action === "reply" ? gate.status : "rejected";
      await database.insert(summonRequests).values({
        tweetId: m.tweetId, requester: m.requester, targetUrl: m.targetUrl ?? "", status,
      });
      await logEvent("skipped", `Summon ${status} (@${m.requester}): ${gate.log}`);
      if (gate.action === "reply") {
        try {
          await xPublisher().publish({ clipUrl: "", postText: gate.text, costUsd: 0, durationS: 0 }, m.tweetId);
        } catch (e) {
          await logEvent("error", `Summon reply failed for @${m.requester}: ${(e as Error).message}`);
        }
        processed++; // the reply counts against the per-run reply budget
      }
      continue;
    }

    const [cand] = await database.insert(candidates).values({
      source: "summon", url: gate.url, videoId: gate.url, title: gate.title,
      speaker: gate.speaker, speakerHandle: gate.speakerHandle ?? "",
      status: "found",
    }).returning();
    const [req] = await database.insert(summonRequests).values({
      tweetId: m.tweetId, requester: m.requester, targetUrl: gate.url,
      status: "received", candidateId: cand.id,
    }).returning();

    // The safety gate passed; skip only the RELEVANCE gate (a human asked): submit the render.
    try {
      const projectId = await opusclipCreateProject(gate.url, opusKey, opusBase, {}, cfg.opusBrandTemplateId);
      await database.update(candidates)
        .set({ status: "rendering", opusProjectId: projectId, renderStartedAt: new Date() })
        .where(eq(candidates.id, cand.id));
      await database.update(summonRequests).set({ status: "clipped" }).where(eq(summonRequests.id, req.id));
      await logEvent("rendering", `Summon: rendering a clip of ${gate.url} for @${m.requester}`, "summon_requests", req.id);
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

/** One of three fates for a mention: render the target, reply with a reason (honest-user
 *  cases), or reject silently (safety). Supports three target shapes: a YouTube/Vimeo link,
 *  an x.com status link, or a native X video on the tag itself / the post it replies to. */
type SummonGate =
  | { action: "render"; url: string; title: string; speaker: string; speakerHandle: string | null }
  | { action: "reply"; status: "no_video" | "rejected"; text: string; log: string }
  | { action: "reject"; log: string };

async function gateMention(m: MentionRaw): Promise<SummonGate> {
  const minMin = Math.round(MIN_SUMMON_VIDEO_S / 60);
  const noVideo: SummonGate = {
    action: "reply", status: "no_video",
    text: `I don't see a video I can clip 👀 Tag me under a post with a video at least ${minMin} minutes long — a native X video or a YouTube/Vimeo link — and I'll pull out the best moment 🎬`,
    log: "no clippable video in the tag or its parent",
  };
  const tooShort = (len: number): SummonGate => ({
    action: "reply", status: "rejected",
    text: `Sorry — I can only clip videos that are at least ${minMin} minutes long, and this one is ${Math.floor(len / 60)}m${String(len % 60).padStart(2, "0")}s. Tag me under a full talk, podcast, or keynote and I'll pull out the best moment 🎬`,
    log: `video too short (${len}s)`,
  });

  // Which X post would carry the video: an x.com link they shared, the tag itself when it has
  // media, else the post they replied to / quoted.
  const xId = m.targetUrl
    ? xStatusIdFromUrl(m.targetUrl)
    : m.mentionHasMedia ? m.tweetId : m.parentTweetId;

  // Non-X link (YouTube/Vimeo path).
  if (m.targetUrl && !xId) {
    const hostCheck = allowedSummonUrl(m.targetUrl);
    if (!hostCheck.allow) {
      return {
        action: "reply", status: "rejected",
        text: `I can clip native X videos and YouTube/Vimeo links (${minMin}+ min) — that link's host isn't supported. Tag me under one of those and I'll grab the best moment 🎬`,
        log: hostCheck.reason,
      };
    }
    const durationS = await fetchVideoDurationS(m.targetUrl);
    if (durationS != null && durationS < MIN_SUMMON_VIDEO_S) return tooShort(durationS);
    const screen = await screenSummonTarget(m.targetUrl, m.text);
    if (!screen.allow) return { action: "reject", log: screen.reason };
    // Credit the channel by name (oEmbed author); never the requester. No handle — tags
    // only ever go to actual people/authors we can verify.
    const meta = await fetchOEmbedMeta(m.targetUrl);
    return {
      action: "render", url: m.targetUrl,
      title: meta?.title || `Summoned by @${m.requester}`,
      speaker: meta?.author ?? "", speakerHandle: null,
    };
  }

  if (!xId) return noVideo;

  // X-native video: gate on X's own sensitivity flag (hard, silent), real media duration,
  // then the Claude screen over the post text + author (no platform moderation underneath).
  let vid: TweetVideo | null = null;
  try {
    vid = await fetchTweetVideo(xId);
  } catch (e) {
    slog("summon_tweet_lookup_error", { xId, error: (e as Error).message });
    return { action: "reject", log: `tweet video lookup failed: ${(e as Error).message}` };
  }
  if (!vid) return noVideo;
  if (vid.possiblySensitive) return { action: "reject", log: "X marked the post possibly_sensitive" };
  if (vid.durationS != null && vid.durationS < MIN_SUMMON_VIDEO_S) return tooShort(vid.durationS);
  const screen = await screenXVideoTarget(m.text, vid.text, vid.authorUsername);
  if (!screen.allow) return { action: "reject", log: screen.reason };
  return {
    action: "render", url: vid.url,
    title: `X video by @${vid.authorUsername} (summoned by @${m.requester})`,
    speaker: vid.authorUsername, speakerHandle: vid.authorUsername,
  };
}
