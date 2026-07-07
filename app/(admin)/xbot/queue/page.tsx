import { desc, eq, inArray } from "drizzle-orm";
import { db, xbotDrafts, xbotTweets } from "@/lib/db";
import XbotDraftCard from "@/components/XbotDraftCard";
import XbotGenerate from "@/components/XbotGenerate";

export const dynamic = "force-dynamic";

export default async function XbotQueuePage() {
  let rows: Awaited<ReturnType<typeof load>>;
  try {
    rows = await load();
  } catch (e) {
    return <div className="text-sm text-amber-300">Database not ready: {(e as Error).message}</div>;
  }

  return (
    <div>
      <XbotGenerate />
      <h2 className="mb-3 text-sm font-medium text-neutral-400">Review queue ({rows.length})</h2>
      <div className="space-y-3">
        {rows.map(({ draft, tweet }) => (
          <XbotDraftCard
            key={draft.id}
            draft={{
              id: draft.id,
              kind: draft.kind,
              contextText: draft.contextText ?? "",
              text: draft.text,
              rationale: draft.rationale ?? "",
              inReplyToTweetId: draft.inReplyToTweetId,
              authorHandle: tweet?.authorHandle ?? null,
              mediaIdea: draft.mediaIdea,
              status: draft.status,
              holdReason: draft.holdReason ?? "",
              tweetedAt: tweet?.tweetedAt ? new Date(tweet.tweetedAt).toISOString() : null,
              likeCount: tweet?.likeCount ?? null,
              replyCount: tweet?.replyCount ?? null,
              viewCount: tweet?.viewCount ?? null,
            }}
          />
        ))}
        {rows.length === 0 && (
          <p className="text-sm text-neutral-500">Queue is empty — generate a draft above.</p>
        )}
      </div>
    </div>
  );
}

async function load() {
  return db()
    .select({ draft: xbotDrafts, tweet: xbotTweets })
    .from(xbotDrafts)
    .leftJoin(xbotTweets, eq(xbotDrafts.tweetRefId, xbotTweets.id))
    .where(inArray(xbotDrafts.status, ["pending_review", "held"]))
    .orderBy(desc(xbotDrafts.createdAt))
    .limit(100);
}
