import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db, xbotDrafts, xbotTargets, xbotTweets, type XbotTarget } from "@/lib/db";
import { logEvent } from "@/lib/pipeline/events";
import { slog } from "@/lib/pipeline/util";
import {
  OUTBOUND_TARGETS_PER_RUN, OUTBOUND_TIMELINE_PAGE, OUTBOUND_TWEET_MAX_AGE_HOURS,
  LIKES_PER_TARGET_PER_RUN,
} from "./config";
import { describeXbotError, xbotRw } from "./client";
import { draftReply } from "./drafting";
import { likeTweet, expireStaleDrafts } from "./engagement";
import { fullTweetText, FULL_TWEET_FIELDS, FULL_TWEET_EXPANSIONS, type RawTweet, type TweetIncludes } from "./fulltext";
import { isDuplicateText, lowValueReason, targetInCooldown } from "./guards";
import { getXbotSettings } from "./settings";

export interface OutboundResult {
  checked: number;   // targets we read a timeline for
  liked: number;     // fresh posts auto-liked (no review, no cooldown)
  drafted: number;   // useful replies queued
  skipped: number;   // cooldown / pending / no-fresh-post / guard-rejected
}

interface TimelineTweet extends RawTweet {
  created_at?: string;
  public_metrics?: { like_count?: number; reply_count?: number };
}

/** The outbound "reply guy" loop: walk the target roster (least-recently-checked first),
 *  read each target's recent ORIGINAL posts (not replies/retweets, no @-tag to us required),
 *  and queue a Claude-drafted, genuinely-useful reply to their best fresh post. Every reply
 *  goes through the same value guard (funny/contrarian/useful — generic praise rejected),
 *  duplicate check, and the review queue.
 *
 *  Budget: reads at most OUTBOUND_TARGETS_PER_RUN timelines (the rate-limited operation).
 *  Targets in reply-cooldown, or that already have a pending draft, are skipped BEFORE any
 *  API call — so the queue never balloons with repeat drafts for the same person while their
 *  earlier draft waits for approval. The daily reply cap + pacing still gate posting. */
export async function checkOutbound(): Promise<OutboundResult> {
  const settings = await getXbotSettings();
  const database = db();
  const client = await xbotRw();
  const result: OutboundResult = { checked: 0, liked: 0, drafted: 0, skipped: 0 };

  // Purge stale pending drafts first — never post a day-late reply, and keep the queue clean.
  await expireStaleDrafts();

  // Round-robin: never-checked first, then oldest checkpoint. Pull a generous slice so
  // cooldown/pending skips don't starve the API budget.
  const roster = await database
    .select().from(xbotTargets)
    .where(notInArray(xbotTargets.status, ["blocked", "archived"]))
    .orderBy(sql`${xbotTargets.lastCheckedAt} asc nulls first`)
    .limit(OUTBOUND_TARGETS_PER_RUN * 4);

  const freshCutoff = Date.now() - OUTBOUND_TWEET_MAX_AGE_HOURS * 3600 * 1000;

  for (const target of roster) {
    if (result.checked >= OUTBOUND_TARGETS_PER_RUN) break;

    // Liking has no cooldown, so we still read (and like) cooldown/pending targets when
    // auto-like is on — that's the always-on engagement. Drafting a reply is gated separately.
    const canDraft = !targetInCooldown(target, settings.cooldownDays) && !(await hasPendingReplyDraft(target.id));
    if (!settings.likesAuto && !canDraft) { result.skipped++; continue; }

    try {
      const userId = await resolveTargetUserId(client, target);
      if (!userId) { await touch(target.id); result.skipped++; continue; }

      const timeline = await client.v2.userTimeline(userId, {
        max_results: OUTBOUND_TIMELINE_PAGE,
        exclude: ["retweets", "replies"], // their ORIGINAL posts only
        "tweet.fields": FULL_TWEET_FIELDS as unknown as string[],
        expansions: FULL_TWEET_EXPANSIONS as unknown as string[],
      } as any).catch((e) => { throw describeXbotError(e); });
      result.checked++;
      await touch(target.id);

      const tweets = (timeline.tweets ?? []) as TimelineTweet[];

      // Auto-like their freshest posts (no review, no cooldown, daily-cap gated).
      if (settings.likesAuto) {
        const freshForLike = tweets
          .filter((t) => (t.created_at ? new Date(t.created_at).getTime() : 0) >= freshCutoff)
          .slice(0, LIKES_PER_TARGET_PER_RUN);
        for (const t of freshForLike) {
          try {
            if (await likeTweet(t.id, target.id, settings.dailyLikeCap)) result.liked++;
          } catch (e) {
            slog("xbot_like_error", { handle: target.handle, error: (e as Error).message });
            break; // stop liking on error (e.g. rate limit) — try again next run
          }
        }
      }

      if (!canDraft) { result.skipped++; continue; }
      const best = await pickBestTweet(tweets, freshCutoff);
      if (!best) { result.skipped++; continue; }

      // Full body (long-form note_tweet + any quoted tweet), not the truncated `text`.
      const fullText = fullTweetText(best, timeline.includes as TweetIncludes);

      const tweetRef = (await database.insert(xbotTweets).values({
        tweetId: best.id,
        targetId: target.id,
        authorHandle: target.handle,
        text: fullText,
        likeCount: best.public_metrics?.like_count ?? 0,
        replyCount: best.public_metrics?.reply_count ?? 0,
        tweetedAt: best.created_at ? new Date(best.created_at) : null,
        foundVia: "roster",
        status: "found",
      }).returning())[0];

      const prior = await priorInteraction(target);
      const isFollowup = Boolean(prior.reply);
      const drafted = await draftReply({
        tweetText: fullText,
        authorHandle: target.handle,
        authorBio: target.bio ?? "",
        voiceNotes: settings.voiceNotes ?? "",
        mission: settings.mission ?? "",
        priorReply: prior.reply,
        priorTweet: prior.tweet,
      });

      const lowValue = lowValueReason(drafted.text, isFollowup ? "followup" : "reply");
      if (lowValue || (await isDuplicateText(drafted.text))) {
        await database.update(xbotTweets).set({ status: "skipped" }).where(eq(xbotTweets.id, tweetRef.id));
        result.skipped++;
        continue;
      }

      await database.insert(xbotDrafts).values({
        kind: isFollowup ? "followup" : "reply",
        targetId: target.id,
        tweetRefId: tweetRef.id,
        inReplyToTweetId: best.id,
        contextText: fullText,
        text: drafted.text,
        rationale: drafted.rationale,
      });
      await database.update(xbotTweets).set({ status: "drafted" }).where(eq(xbotTweets.id, tweetRef.id));
      result.drafted++;
    } catch (e) {
      slog("xbot_outbound_target_error", { handle: target.handle, error: (e as Error).message });
      result.skipped++;
    }
  }

  await logEvent(
    "xbot_outbound",
    `Outbound roster check: read ${result.checked} timeline(s), liked ${result.liked}, drafted ${result.drafted} reply(ies)`,
  );
  slog("xbot_outbound", { ...result });
  return result;
}

/** Hydrate (and cache) a target's X user id + bio from their handle when we don't have it. */
async function resolveTargetUserId(
  client: Awaited<ReturnType<typeof xbotRw>>,
  target: XbotTarget,
): Promise<string | null> {
  if (target.xUserId) return target.xUserId;
  const res = await client.v2.userByUsername(target.handle, {
    "user.fields": ["description", "public_metrics"],
  }).catch((e) => { throw describeXbotError(e); });
  const user = res.data;
  if (!user) return null;
  await db().update(xbotTargets).set({
    xUserId: user.id,
    ...(target.bio ? {} : { bio: user.description ?? "" }),
    ...(user.public_metrics?.followers_count != null ? { followers: user.public_metrics.followers_count } : {}),
  }).where(eq(xbotTargets.id, target.id));
  return user.id;
}

/** The freshest post worth replying to: within the freshness window, not already seen,
 *  preferring ones with some traction (a reply there gets seen) then most recent. */
async function pickBestTweet(tweets: TimelineTweet[], freshCutoff: number): Promise<TimelineTweet | null> {
  const fresh = tweets.filter((t) => {
    const at = t.created_at ? new Date(t.created_at).getTime() : 0;
    return at >= freshCutoff;
  });
  if (!fresh.length) return null;

  const seenRows = await db()
    .select({ tweetId: xbotTweets.tweetId }).from(xbotTweets)
    .where(inArray(xbotTweets.tweetId, fresh.map((t) => t.id)));
  const seen = new Set(seenRows.map((r) => r.tweetId));
  const unseen = fresh.filter((t) => !seen.has(t.id));
  if (!unseen.length) return null;

  const traction = (t: TimelineTweet) =>
    (t.public_metrics?.like_count ?? 0) + (t.public_metrics?.reply_count ?? 0);
  unseen.sort((a, b) => {
    const d = traction(b) - traction(a);
    if (d !== 0) return d;
    return new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime();
  });
  return unseen[0];
}

/** True if this target already has an unreviewed reply/follow-up draft — don't stack another. */
async function hasPendingReplyDraft(targetId: number): Promise<boolean> {
  const rows = await db()
    .select({ id: xbotDrafts.id }).from(xbotDrafts)
    .where(and(
      eq(xbotDrafts.targetId, targetId),
      eq(xbotDrafts.status, "pending_review"),
    ))
    .limit(10);
  return rows.length > 0;
}

/** Last reply we actually posted to this target, for follow-up continuity in the prompt. */
async function priorInteraction(target: XbotTarget): Promise<{ reply?: string; tweet?: string }> {
  if ((target.repliesSent ?? 0) <= 0) return {};
  const last = (await db()
    .select().from(xbotDrafts)
    .where(eq(xbotDrafts.targetId, target.id))
    .orderBy(desc(xbotDrafts.postedAt))
    .limit(50))
    .find((d) => d.status === "posted" && (d.kind === "reply" || d.kind === "followup"));
  return last ? { reply: last.text, tweet: last.contextText ?? "" } : {};
}

async function touch(targetId: number): Promise<void> {
  await db().update(xbotTargets).set({ lastCheckedAt: new Date() }).where(eq(xbotTargets.id, targetId));
}
