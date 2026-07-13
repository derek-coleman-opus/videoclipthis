import { eq } from "drizzle-orm";
import { db, xbotDrafts, xbotTargets, xbotTweets } from "@/lib/db";
import { logEvent } from "@/lib/pipeline/events";
import { slog } from "@/lib/pipeline/util";
import { describeXbotError, xbotRw } from "./client";
import { draftEngageBack } from "./drafting";
import { fullTweetText, type TweetIncludes } from "./fulltext";
import { isDuplicateText } from "./guards";
import { reportHealth } from "./health";
import { getXbotSettings, updateXbotSettings } from "./settings";

export interface InboundResult {
  found: number;
  drafted: number;
  skipped: number;
}

/** "Reply to everyone who engages with your posts" — health-reported wrapper so an API
 *  failure (usage cap, rate limit) surfaces on the dashboard instead of only in logs. */
export async function checkInbound(): Promise<InboundResult> {
  try {
    const result = await checkInboundInner();
    await reportHealth("inbound", true);
    return result;
  } catch (e) {
    await reportHealth("inbound", false, (e as Error).message);
    throw e;
  }
}

/** Pull new mentions — replies to our posts AND replies to our replies both land in the
 *  mentions timeline — record each engager's comment, and queue a Claude-drafted engage-back
 *  for review. The cursor lives in xbot_settings.mentionsSinceId so each run only sees new
 *  engagement; failed drafts stay status "found" and are retried on the next run. */
async function checkInboundInner(): Promise<InboundResult> {
  const settings = await getXbotSettings();
  if (settings.paused) return { found: 0, drafted: 0, skipped: 0 };
  const database = db();
  const client = await xbotRw();

  let meId = settings.xbotUserId;
  if (!meId) {
    const me = await client.v2.me().catch((e) => { throw describeXbotError(e); });
    meId = me.data.id;
    await updateXbotSettings({ xbotUserId: meId });
  }

  const timeline = await client.v2.userMentionTimeline(meId, {
    max_results: 50,
    ...(settings.mentionsSinceId ? { since_id: settings.mentionsSinceId } : {}),
    expansions: ["author_id", "referenced_tweets.id"],
    "tweet.fields": ["author_id", "created_at", "referenced_tweets", "text", "note_tweet"],
    "user.fields": ["username", "description"],
  }).catch((e) => { throw describeXbotError(e); });

  const mentions = timeline.tweets ?? [];
  const users = timeline.includes?.users ?? [];
  const refTweets = timeline.includes?.tweets ?? [];
  const result: InboundResult = { found: 0, drafted: 0, skipped: 0 };

  // Oldest first so conversations are drafted in the order they happened.
  for (const mention of [...mentions].reverse()) {
    const author = users.find((u) => u.id === mention.author_id);
    if (!author || author.id === meId) continue;
    result.found++;

    // Full body (long-form note_tweet + any quoted post), not the truncated `text`.
    const theirText = fullTweetText(mention, timeline.includes as TweetIncludes);

    let tweetRef = (await database
      .select().from(xbotTweets)
      .where(eq(xbotTweets.tweetId, mention.id)).limit(1))[0];
    if (tweetRef && tweetRef.status !== "found") {
      result.skipped++; // already drafted or deliberately skipped
      continue;
    }

    const target = (await database
      .select().from(xbotTargets)
      .where(eq(xbotTargets.handle, author.username)).limit(1))[0];
    if (target && !target.engagedBack) {
      await database.update(xbotTargets)
        .set({ engagedBack: true, status: "engaged_back" })
        .where(eq(xbotTargets.id, target.id));
    }

    if (!tweetRef) {
      [tweetRef] = await database.insert(xbotTweets).values({
        tweetId: mention.id,
        targetId: target?.id ?? null,
        authorHandle: author.username,
        text: theirText,
        tweetedAt: mention.created_at ? new Date(mention.created_at) : null,
        foundVia: "inbound",
        status: "found",
      }).returning();
    }

    // What of ours they were responding to, when the parent is in the includes and ours.
    const parentId = mention.referenced_tweets?.find((r) => r.type === "replied_to")?.id;
    const parent = parentId ? refTweets.find((t) => t.id === parentId) : undefined;
    const ourText = parent?.author_id === meId
      ? fullTweetText(parent, timeline.includes as TweetIncludes)
      : undefined;

    try {
      const drafted = await draftEngageBack({
        theirText,
        theirHandle: author.username,
        ourText,
        voiceNotes: settings.voiceNotes ?? "",
        mission: settings.mission ?? "",
      });
      if (await isDuplicateText(drafted.text)) {
        await database.update(xbotTweets).set({ status: "skipped" }).where(eq(xbotTweets.id, tweetRef.id));
        result.skipped++;
        continue;
      }
      await database.insert(xbotDrafts).values({
        kind: "engage",
        targetId: target?.id ?? null,
        tweetRefId: tweetRef.id,
        inReplyToTweetId: mention.id,
        contextText: theirText,
        text: drafted.text,
        rationale: drafted.rationale,
      });
      await database.update(xbotTweets).set({ status: "drafted" }).where(eq(xbotTweets.id, tweetRef.id));
      result.drafted++;
    } catch (e) {
      // Leave the tweet status "found" so the next run retries this engager.
      slog("xbot_inbound_draft_error", { tweetId: mention.id, error: (e as Error).message });
      result.skipped++;
    }
  }

  const newestId = timeline.meta?.newest_id;
  if (newestId) await updateXbotSettings({ mentionsSinceId: newestId });

  await logEvent(
    "xbot_inbound",
    `Inbound check: ${result.found} new engager(s), ${result.drafted} engage-back(s) drafted`,
  );
  slog("xbot_inbound", { ...result });
  return result;
}
