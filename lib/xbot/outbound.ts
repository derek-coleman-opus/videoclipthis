import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db, xbotDrafts, xbotTargets, xbotTweets, type XbotTarget } from "@/lib/db";
import { logEvent } from "@/lib/pipeline/events";
import { slog } from "@/lib/pipeline/util";
import {
  OUTBOUND_TARGETS_PER_RUN, OUTBOUND_TIMELINE_PAGE, OUTBOUND_TWEET_MAX_AGE_HOURS,
} from "./config";
import { describeXbotError, xbotRw } from "./client";
import { draftReply } from "./drafting";
import { expireStaleDrafts } from "./engagement";
import { fullTweetText, FULL_TWEET_FIELDS, FULL_TWEET_EXPANSIONS, type RawTweet, type TweetIncludes } from "./fulltext";
import { isDuplicateText, lowValueReason, targetInCooldown } from "./guards";
import { reportHealth } from "./health";
import { getXbotSettings } from "./settings";

export interface OutboundResult {
  checked: number;      // targets we read a timeline for
  queuedLikes: number;  // fresh posts stored for the paced like queue (runLikes drains it)
  drafted: number;      // useful replies queued
  skipped: number;      // cooldown / pending / no-fresh-post / guard-rejected
}

interface TimelineTweet extends RawTweet {
  created_at?: string;
  public_metrics?: { like_count?: number; reply_count?: number; impression_count?: number };
}

/** Only reply to a post that's actually worth a reply: real substance (not a bare link, "gm",
 *  or a one-word tweet), and enough of a thought to react to. Keeps the bot from commenting on
 *  things that make no sense to comment on. */
function worthReplyingTo(text: string): boolean {
  const stripped = text
    .replace(/https?:\/\/\S+/g, " ")   // drop links
    .replace(/@\w+/g, " ")             // drop @mentions
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // drop emoji/punctuation
    .replace(/\s+/g, " ")
    .trim();
  const words = stripped.split(" ").filter(Boolean);
  return stripped.length >= 25 && words.length >= 5;
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
  const result: OutboundResult = { checked: 0, queuedLikes: 0, drafted: 0, skipped: 0 };

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
  let lastError: string | null = null;

  for (const target of roster) {
    if (result.checked >= OUTBOUND_TARGETS_PER_RUN) break;

    // Storing tweets for the like queue has no cooldown, so we still read cooldown/pending
    // targets when auto-like is on. Drafting a reply is gated separately.
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
      const fresh = tweets.filter(
        (t) => (t.created_at ? new Date(t.created_at).getTime() : 0) >= freshCutoff,
      );
      if (!fresh.length) { result.skipped++; continue; }

      // Which of these have we already stored? (Needed BEFORE the bulk insert below, both to
      // count what's new and to keep the reply picker to genuinely new posts.)
      const seenRows = await database
        .select({ tweetId: xbotTweets.tweetId }).from(xbotTweets)
        .where(inArray(xbotTweets.tweetId, fresh.map((t) => t.id)));
      const seen = new Set(seenRows.map((r) => r.tweetId));
      const unseen = fresh.filter((t) => !seen.has(t.id));

      // Store EVERY fresh post (not just the reply pick): this feeds the paced like queue —
      // runLikes (every 15 min) drains it under quiet-hours + hourly caps, instead of the old
      // inline burst-liking that ignored pacing. Dedup via the unique tweet_id index.
      if (unseen.length) {
        await database.insert(xbotTweets).values(unseen.map((t) => ({
          tweetId: t.id,
          targetId: target.id,
          authorHandle: target.handle,
          text: fullTweetText(t, timeline.includes as TweetIncludes),
          likeCount: t.public_metrics?.like_count ?? 0,
          replyCount: t.public_metrics?.reply_count ?? 0,
          viewCount: t.public_metrics?.impression_count ?? 0,
          tweetedAt: t.created_at ? new Date(t.created_at) : null,
          foundVia: "roster" as const,
          status: "found" as const,
        }))).onConflictDoNothing();
        result.queuedLikes += unseen.length;
      }

      if (!canDraft) { result.skipped++; continue; }
      const best = pickBestTweet(unseen);
      if (!best) { result.skipped++; continue; }

      // Full body (long-form note_tweet + any quoted tweet), not the truncated `text`.
      const fullText = fullTweetText(best, timeline.includes as TweetIncludes);

      // Skip posts that make no sense to reply to (bare links, "gm", one-liners).
      if (!worthReplyingTo(fullText)) { result.skipped++; continue; }

      const tweetRef = (await database
        .select().from(xbotTweets)
        .where(eq(xbotTweets.tweetId, best.id)).limit(1))[0];
      if (!tweetRef) { result.skipped++; continue; }

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
      lastError = (e as Error).message;
      slog("xbot_outbound_target_error", { handle: target.handle, error: lastError });
      result.skipped++;
    }
  }

  // Health: if there was a roster to read but ZERO timelines could be read and we saw errors,
  // the reads are down (usage cap / rate limit) — the reply pipeline AND like supply are stalled.
  const readsDown = roster.length > 0 && result.checked === 0 && lastError !== null;
  await reportHealth("outbound", !readsDown, readsDown ? lastError ?? undefined : undefined);

  await logEvent(
    "xbot_outbound",
    `Outbound roster check: read ${result.checked} timeline(s), queued ${result.queuedLikes} post(s) for liking, drafted ${result.drafted} reply(ies)`,
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

/** The best new post to reply to: prefer traction (a reply there gets seen), then recency.
 *  Caller has already filtered to fresh + previously-unseen tweets. */
function pickBestTweet(unseen: TimelineTweet[]): TimelineTweet | null {
  if (!unseen.length) return null;
  const traction = (t: TimelineTweet) =>
    (t.public_metrics?.like_count ?? 0) + (t.public_metrics?.reply_count ?? 0);
  return [...unseen].sort((a, b) => {
    const d = traction(b) - traction(a);
    if (d !== 0) return d;
    return new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime();
  })[0];
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
