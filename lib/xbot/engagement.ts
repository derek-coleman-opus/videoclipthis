import { and, eq, lt, sql } from "drizzle-orm";
import { db, xbotActions, xbotDrafts, xbotTargets, type XbotDraft } from "@/lib/db";
import { logEvent } from "@/lib/pipeline/events";
import { slog } from "@/lib/pipeline/util";
import { describeXbotError, xbotRw, xbotUserId } from "./client";
import { getXbotSettings } from "./settings";
import { pacingViolation, underCap } from "./guards";
import { DRAFT_TTL_H } from "./config";

/** Expire pending drafts older than the TTL — the tweet they reply to has gone stale, so we
 *  never post a day-late reply. They drop out of the review queue (which shows only pending). */
export async function expireStaleDrafts(): Promise<number> {
  const cutoff = new Date(Date.now() - DRAFT_TTL_H * 3600 * 1000);
  const rows = await db().update(xbotDrafts)
    .set({ status: "expired" })
    .where(and(eq(xbotDrafts.status, "pending_review"), lt(xbotDrafts.createdAt, cutoff)))
    .returning({ id: xbotDrafts.id });
  if (rows.length) {
    await logEvent("xbot_outbound", `Expired ${rows.length} stale draft(s) (>${DRAFT_TTL_H}h old)`);
  }
  return rows.length;
}

/** Auto-like a tweet as the personal account: deduped, daily-cap-gated, recorded in the ledger.
 *  Likes need no review (the safe, always-on engagement signal). Returns true if a like fired. */
export async function likeTweet(tweetId: string, targetId: number | null, dailyLikeCap: number): Promise<boolean> {
  const database = db();
  // Never like the same tweet twice.
  const already = await database.select({ id: xbotActions.id }).from(xbotActions)
    .where(and(eq(xbotActions.kind, "like"), eq(xbotActions.tweetId, tweetId))).limit(1);
  if (already.length) return false;
  if (!(await underCap("like", dailyLikeCap))) return false;

  const client = await xbotRw();
  const uid = await xbotUserId();
  await client.v2.like(uid, tweetId).catch((e) => { throw describeXbotError(e); });
  await database.insert(xbotActions).values({ kind: "like", targetId, tweetId });
  return true;
}

export interface PostOutcome {
  xPostId: string;
}

/** Post a single approved draft to X as the personal account, enforcing the daily cap
 *  for its kind, recording the action in the ledger, and updating the draft + target.
 *  Throws (and marks the draft failed) on any X error so the dashboard shows it loudly. */
export async function postDraft(draft: XbotDraft): Promise<PostOutcome> {
  const settings = await getXbotSettings();
  // "plug" is a self-reply under our own traction post — mechanically a reply.
  // "engage" (responding to someone who commented on us) gets its own, higher cap so
  // replying to everyone never competes with the outbound growth-reply budget.
  const isReply = ["reply", "followup", "plug", "engage"].includes(draft.kind);
  const capKind = draft.kind === "engage" ? "engage" : isReply ? "reply" : "post";
  const cap = draft.kind === "engage" ? settings.dailyEngageCap
    : isReply ? settings.dailyReplyCap : settings.dailyPostCap;
  if (!(await underCap(capKind, cap))) {
    throw new Error(`daily ${capKind} cap (${cap}) reached — try again tomorrow or raise the cap`);
  }
  const pacing = await pacingViolation(capKind, cap, settings);
  if (pacing) throw new Error(pacing);

  const database = db();
  try {
    const client = await xbotRw();
    const payload: Record<string, unknown> = { text: draft.text };
    if (draft.inReplyToTweetId) payload.reply = { in_reply_to_tweet_id: draft.inReplyToTweetId };
    // Small-account reach hack: post originals into one big niche community instead of
    // the void. Replies always go to the thread, never the community.
    if (!isReply && settings.communityId) payload.community_id = settings.communityId;
    const res = await client.v2.tweet(payload as any).catch((e) => { throw describeXbotError(e); });
    const xPostId = res.data.id;

    await database.update(xbotDrafts)
      .set({ status: "posted", xPostId, postedAt: new Date() })
      .where(eq(xbotDrafts.id, draft.id));
    await database.insert(xbotActions).values({
      kind: capKind, targetId: draft.targetId, tweetId: xPostId,
    });
    // Only outbound growth replies advance the per-target cooldown — engage-backs and
    // plugs are conversation, and must never suppress a future outbound reply.
    if ((draft.kind === "reply" || draft.kind === "followup") && draft.targetId) {
      await database.update(xbotTargets)
        .set({
          lastRepliedAt: new Date(),
          repliesSent: sql`${xbotTargets.repliesSent} + 1`,
          status: "active",
        })
        .where(eq(xbotTargets.id, draft.targetId));
    }
    await logEvent(
      isReply ? "xbot_replied" : "xbot_posted",
      isReply ? `Replied to tweet ${draft.inReplyToTweetId}` : `Posted: ${draft.text.slice(0, 80)}`,
      "xbot_drafts", draft.id,
    );
    slog("xbot_post", { draftId: draft.id, kind: draft.kind, xPostId });
    return { xPostId };
  } catch (e) {
    await database.update(xbotDrafts).set({ status: "failed" }).where(eq(xbotDrafts.id, draft.id));
    await logEvent("xbot_error", `Post failed for draft #${draft.id}: ${(e as Error).message}`, "xbot_drafts", draft.id);
    throw e;
  }
}
