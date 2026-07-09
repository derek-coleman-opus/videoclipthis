import { and, desc, eq, inArray } from "drizzle-orm";
import { db, xbotActions, xbotTweets } from "@/lib/db";
import { logEvent } from "@/lib/pipeline/events";
import { sleep, slog } from "@/lib/pipeline/util";
import { HARVEST_QUERIES_PER_RUN, HARVEST_MAX_PER_RUN, SEARCH_MAX_RESULTS } from "./config";
import { describeXbotError, xbotRw } from "./client";
import { countActionsSince, countActionsToday, hourlyCap, inQuietHours } from "./guards";
import { reportHealth } from "./health";
import { getXbotSettings, parseKeywords, updateXbotSettings } from "./settings";

/** Hard ceiling per run so a single invocation never bursts a pile of likes. The xbot-post cron
 *  runs every 15 min, so 4 runs/hour × this = the max like throughput (hourly cap still applies). */
const LIKES_PER_RUN = Number(process.env.XBOT_LIKES_PER_RUN ?? 8);

/** Random pause BETWEEN consecutive likes in a run, so timestamps spread like a human scrolling
 *  a feed instead of 8 likes in the same second. Worst case (LIKES_PER_RUN-1) × max = ~175s,
 *  safely inside the 300s route budget shared with draft posting. */
const LIKE_JITTER_MIN_S = Number(process.env.XBOT_LIKE_JITTER_MIN_S ?? 10);
const LIKE_JITTER_MAX_S = Number(process.env.XBOT_LIKE_JITTER_MAX_S ?? 25);

export interface LikeResult {
  liked: number;
  skipped?: string;
}

/** Auto-like the freshest stored tweets — roster timelines, inbound engagers, and keyword-search
 *  harvests (no new timeline reads here). Respects likesAuto, quiet hours, the daily like cap,
 *  and the derived hourly cap so likes trickle out like a human's, not in a burst. Records each
 *  like in the action ledger. */
export async function runLikes(): Promise<LikeResult> {
  // A benign skip is still a healthy RUN — report it, so "running but idle" (empty supply,
  // caps, quiet hours) is distinguishable from "not running at all" on the health ledger.
  const healthySkip = async (result: LikeResult): Promise<LikeResult> => {
    await reportHealth("likes", true);
    return result;
  };

  const settings = await getXbotSettings();
  if (!settings.likesAuto) return healthySkip({ liked: 0, skipped: "likesAuto off" });
  if (inQuietHours(settings)) return healthySkip({ liked: 0, skipped: "quiet hours" });

  const remainingDaily = settings.dailyLikeCap - (await countActionsToday("like"));
  if (remainingDaily <= 0) return healthySkip({ liked: 0, skipped: "daily like cap reached" });
  const remainingHour = hourlyCap(settings.dailyLikeCap, settings) - (await countActionsSince("like", new Date(Date.now() - 3600_000)));
  const budget = Math.max(0, Math.min(LIKES_PER_RUN, remainingDaily, remainingHour));
  if (budget <= 0) return healthySkip({ liked: 0, skipped: "hourly like cap reached" });

  const database = db();
  const candidates = await database
    .select().from(xbotTweets)
    .where(and(eq(xbotTweets.liked, false), inArray(xbotTweets.foundVia, ["roster", "inbound", "search"])))
    .orderBy(desc(xbotTweets.tweetedAt))
    .limit(budget);
  if (!candidates.length) return healthySkip({ liked: 0, skipped: "nothing new to like" });

  const client = await xbotRw();
  let meId = settings.xbotUserId;
  if (!meId) {
    const me = await client.v2.me().catch((e) => { throw describeXbotError(e); });
    meId = me.data.id;
    await updateXbotSettings({ xbotUserId: meId });
  }

  let liked = 0;
  let likeError: string | null = null;
  for (const tw of candidates) {
    try {
      // Human-like spacing between likes (skip before the first).
      if (liked > 0) {
        const jitterMs = (LIKE_JITTER_MIN_S + Math.random() * Math.max(0, LIKE_JITTER_MAX_S - LIKE_JITTER_MIN_S)) * 1000;
        await sleep(jitterMs);
      }
      await client.v2.like(meId, tw.tweetId);
      await database.update(xbotTweets).set({ liked: true, likedAt: new Date() }).where(eq(xbotTweets.id, tw.id));
      await database.insert(xbotActions).values({ kind: "like", targetId: tw.targetId, tweetId: tw.tweetId });
      liked++;
    } catch (e) {
      // Likely a rate limit or a deleted tweet — stop this run rather than hammer the API.
      likeError = (e as Error).message;
      slog("xbot_like_error", { tweetId: tw.tweetId, error: likeError });
      break;
    }
  }
  // Health: an errored run (even with partial likes) must surface — this is exactly the
  // "silently stopped 10 hours ago" failure mode.
  await reportHealth("likes", likeError === null, likeError ?? undefined);
  if (liked) await logEvent("xbot_liked", `Auto-liked ${liked} tweet(s)`);
  slog("xbot_likes", { liked });
  return { liked };
}

/** Minimum substance for a like-worthy post (same idea as outbound's reply gate, looser). */
function likeWorthy(text: string): boolean {
  const stripped = text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/@\w+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length >= 15 && stripped.split(" ").filter(Boolean).length >= 3;
}

export interface HarvestResult {
  searched: number;
  stored: number;
  skipped?: string;
}

/** Keyword-search like harvesting — the volume unlock. The roster (~1-3 posts/target/day) can't
 *  supply hundreds of likes/day, so we also search the niche keywords for fresh original posts
 *  and store them (foundVia:"search") for runLikes to drain under its pacing. Rotates through
 *  the keyword list across runs (same pattern as runDiscovery); dedup via the unique tweet_id
 *  index. Storing is not liking: pacing/caps stay entirely in runLikes. */
export async function harvestSearchTweets(): Promise<HarvestResult> {
  // Benign skips still count as healthy runs on the ledger (see runLikes).
  const healthySkip = async (result: HarvestResult): Promise<HarvestResult> => {
    await reportHealth("harvest", true);
    return result;
  };

  const settings = await getXbotSettings();
  if (!settings.likesAuto) return healthySkip({ searched: 0, stored: 0, skipped: "likesAuto off" });

  const keywords = parseKeywords(settings);
  if (!keywords.length) return healthySkip({ searched: 0, stored: 0, skipped: "no keywords configured" });

  // Don't over-harvest: if the unliked backlog already covers a day at the current cap,
  // skip the search spend this run.
  const database = db();
  const backlog = await database
    .select({ id: xbotTweets.id }).from(xbotTweets)
    .where(and(eq(xbotTweets.liked, false), inArray(xbotTweets.foundVia, ["roster", "inbound", "search"])))
    .limit(settings.dailyLikeCap);
  if (backlog.length >= settings.dailyLikeCap) {
    return healthySkip({ searched: 0, stored: 0, skipped: "like backlog full" });
  }

  // Rotate which keywords run each invocation so the whole list gets coverage over the day.
  const offset = Math.floor(Date.now() / 3_600_000) % keywords.length;
  const rotated = [...keywords.slice(offset), ...keywords.slice(0, offset)];
  const queries = rotated.slice(0, HARVEST_QUERIES_PER_RUN);

  const client = await xbotRw();
  const meId = settings.xbotUserId;
  const result: HarvestResult = { searched: 0, stored: 0 };
  let lastError: string | null = null;

  for (const kw of queries) {
    if (result.stored >= HARVEST_MAX_PER_RUN) break;
    try {
      const res = await client.v2.search(`${kw} -is:retweet -is:reply lang:en`, {
        max_results: Math.max(10, SEARCH_MAX_RESULTS),
        expansions: ["author_id"],
        "tweet.fields": ["author_id", "text", "created_at", "public_metrics"],
        "user.fields": ["username"],
      }).catch((e) => { throw describeXbotError(e); });
      result.searched++;

      const users = new Map((res.includes?.users ?? []).map((u) => [u.id, u]));
      const rows = [];
      for (const t of res.tweets ?? []) {
        if (result.stored + rows.length >= HARVEST_MAX_PER_RUN) break;
        const author = t.author_id ? users.get(t.author_id) : undefined;
        if (!author || author.id === meId) continue;
        if (!likeWorthy(t.text ?? "")) continue;
        rows.push({
          tweetId: t.id,
          targetId: null,
          authorHandle: author.username,
          text: t.text ?? "",
          likeCount: (t as any).public_metrics?.like_count ?? 0,
          replyCount: (t as any).public_metrics?.reply_count ?? 0,
          viewCount: (t as any).public_metrics?.impression_count ?? 0,
          tweetedAt: (t as any).created_at ? new Date((t as any).created_at) : null,
          foundVia: "search" as const,
          status: "found" as const,
        });
      }
      if (rows.length) {
        const inserted = await database.insert(xbotTweets).values(rows)
          .onConflictDoNothing().returning({ id: xbotTweets.id });
        result.stored += inserted.length;
      }
    } catch (e) {
      lastError = (e as Error).message;
      slog("xbot_harvest_error", { query: kw, error: lastError });
    }
  }

  // Health: failing means the like supply dries up quietly — every query erroring is a real
  // outage (usage cap / rate limit); partial success still counts as ok.
  const allFailed = queries.length > 0 && result.searched === 0 && lastError !== null;
  await reportHealth("harvest", !allFailed, allFailed ? lastError ?? undefined : undefined);

  slog("xbot_harvest", { ...result });
  return result;
}
