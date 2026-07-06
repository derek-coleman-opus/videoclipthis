import { and, desc, eq, inArray } from "drizzle-orm";
import { db, xbotActions, xbotTweets } from "@/lib/db";
import { logEvent } from "@/lib/pipeline/events";
import { slog } from "@/lib/pipeline/util";
import { describeXbotError, xbotRw } from "./client";
import { countActionsSince, countActionsToday, hourlyCap, inQuietHours } from "./guards";
import { getXbotSettings, updateXbotSettings } from "./settings";

/** Hard ceiling per run so a single invocation never bursts a pile of likes. */
const LIKES_PER_RUN = Number(process.env.XBOT_LIKES_PER_RUN ?? 5);

export interface LikeResult {
  liked: number;
  skipped?: string;
}

/** Auto-like the freshest tweets we've already stored from the roster/inbound (no new timeline
 *  reads). Respects likesAuto, quiet hours, the daily like cap, and the derived hourly cap so
 *  likes trickle out like a human's, not in a burst. Records each like in the action ledger. */
export async function runLikes(): Promise<LikeResult> {
  const settings = await getXbotSettings();
  if (!settings.likesAuto) return { liked: 0, skipped: "likesAuto off" };
  if (inQuietHours(settings)) return { liked: 0, skipped: "quiet hours" };

  const remainingDaily = settings.dailyLikeCap - (await countActionsToday("like"));
  if (remainingDaily <= 0) return { liked: 0, skipped: "daily like cap reached" };
  const remainingHour = hourlyCap(settings.dailyLikeCap, settings) - (await countActionsSince("like", new Date(Date.now() - 3600_000)));
  const budget = Math.max(0, Math.min(LIKES_PER_RUN, remainingDaily, remainingHour));
  if (budget <= 0) return { liked: 0, skipped: "hourly like cap reached" };

  const database = db();
  const candidates = await database
    .select().from(xbotTweets)
    .where(and(eq(xbotTweets.liked, false), inArray(xbotTweets.foundVia, ["roster", "inbound"])))
    .orderBy(desc(xbotTweets.tweetedAt))
    .limit(budget);
  if (!candidates.length) return { liked: 0, skipped: "nothing new to like" };

  const client = await xbotRw();
  let meId = settings.xbotUserId;
  if (!meId) {
    const me = await client.v2.me().catch((e) => { throw describeXbotError(e); });
    meId = me.data.id;
    await updateXbotSettings({ xbotUserId: meId });
  }

  let liked = 0;
  for (const tw of candidates) {
    try {
      await client.v2.like(meId, tw.tweetId);
      await database.update(xbotTweets).set({ liked: true, likedAt: new Date() }).where(eq(xbotTweets.id, tw.id));
      await database.insert(xbotActions).values({ kind: "like", targetId: tw.targetId, tweetId: tw.tweetId });
      liked++;
    } catch (e) {
      // Likely a rate limit or a deleted tweet — stop this run rather than hammer the API.
      slog("xbot_like_error", { tweetId: tw.tweetId, error: (e as Error).message });
      break;
    }
  }
  if (liked) await logEvent("xbot_liked", `Auto-liked ${liked} tweet(s)`);
  slog("xbot_likes", { liked });
  return { liked };
}
