// Read-only X (v2) access for the feedback loop (metrics + reshares) and summon (mentions).
// Uses the app-only bearer token so reads don't consume the posting credentials' rate budget.
import { withRetry } from "./util";

export interface ClipMetrics {
  views: number;
  retweets: number;
  quotes: number;
}

async function v2() {
  const { TwitterApi } = await import("twitter-api-v2");
  const token = process.env.X_BEARER_TOKEN ?? "";
  return new TwitterApi(token).readOnly.v2;
}

/** Batch-fetch public metrics for posted tweets (chunks of 100, the /2/tweets cap). */
export async function fetchPublicMetrics(ids: string[]): Promise<Map<string, ClipMetrics>> {
  const out = new Map<string, ClipMetrics>();
  if (!ids.length) return out;
  const client = await v2();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const res: any = await withRetry(
      () => client.tweets(chunk, { "tweet.fields": ["public_metrics"] }),
      { label: "x tweets metrics" },
    );
    for (const t of res.data ?? []) {
      const m = t.public_metrics ?? {};
      out.set(t.id, {
        views: Number(m.impression_count ?? 0),
        retweets: Number(m.retweet_count ?? 0),
        quotes: Number(m.quote_count ?? 0),
      });
    }
  }
  return out;
}

/** Did the given @handle retweet or quote this tweet? Best-effort; only call when it's worth it. */
export async function didHandleReshare(tweetId: string, handle: string): Promise<boolean> {
  const want = handle.replace(/^@/, "").toLowerCase();
  if (!want) return false;
  const client = await v2();
  try {
    const rt: any = await withRetry(() => client.tweetRetweetedBy(tweetId), { label: "x retweeted_by" });
    if ((rt.data ?? []).some((u: any) => (u.username ?? "").toLowerCase() === want)) return true;
  } catch {
    /* endpoint may be unavailable on the tier — fall through to quotes */
  }
  try {
    const q: any = await withRetry(
      () => client.quotes(tweetId, { expansions: ["author_id"], "user.fields": ["username"] }),
      { label: "x quote_tweets" },
    );
    const users = q.includes?.users ?? q._realData?.includes?.users ?? [];
    if (users.some((u: any) => (u.username ?? "").toLowerCase() === want)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

export { v2 as xReadV2 };
