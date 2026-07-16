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

/** User-context v2 client (the posting creds) — needed for endpoints like /2/users/me. */
async function v2rw() {
  const { TwitterApi } = await import("twitter-api-v2");
  return new TwitterApi({
    appKey: process.env.X_API_KEY ?? "",
    appSecret: process.env.X_API_SECRET ?? "",
    accessToken: process.env.X_ACCESS_TOKEN ?? "",
    accessSecret: process.env.X_ACCESS_SECRET ?? "",
  }).v2;
}

/** The bot's own X user id (cache it — it never changes). */
export async function getBotUserId(): Promise<string> {
  const me: any = await withRetry(async () => (await v2rw()).me(), { label: "x me" });
  return me.data.id;
}

export interface MentionRaw {
  tweetId: string;
  requester: string;
  text: string;               // the mention's own text — safety screening input
  targetUrl: string | null;   // first URL in the mention or its parent (YouTube/Vimeo/X links)
  mentionHasMedia: boolean;   // the mention itself carries attachments (user posted the video)
  parentTweetId: string | null; // the tweet replied to / quoted — where the video usually lives
}

/** Pull the first http(s) URL out of a tweet's entities (expanded form preferred). */
function urlsFromTweet(t: any): string[] {
  return (t?.entities?.urls ?? [])
    .map((u: any) => u.expanded_url ?? u.url)
    .filter((u: string) => /^https?:\/\//.test(u ?? ""));
}

/**
 * New @mentions since `sinceId`. The target video URL is taken from the mention itself, else
 * from the tweet it replied to / quoted (people usually tag the bot under the video).
 */
export async function fetchMentions(
  userId: string,
  sinceId?: string | null,
): Promise<{ mentions: MentionRaw[]; newestId: string | null }> {
  const client = await v2();
  const params: any = {
    max_results: 50,
    expansions: ["referenced_tweets.id", "author_id", "referenced_tweets.id.author_id"],
    "tweet.fields": ["entities", "referenced_tweets", "author_id", "attachments"],
    "user.fields": ["username"],
  };
  if (sinceId) params.since_id = sinceId;

  const res: any = await withRetry(() => client.userMentionTimeline(userId, params), { label: "x mentions" });
  const tweets: any[] = res.tweets ?? [];
  const includes = res.includes;

  const mentions: MentionRaw[] = tweets.map((t) => {
    const referenced = includes?.repliedTo?.(t) ?? includes?.quote?.(t);
    const urls = urlsFromTweet(t).length ? urlsFromTweet(t) : urlsFromTweet(referenced);
    const parentId = t.referenced_tweets?.find((r: any) => r.type === "replied_to")?.id
      ?? t.referenced_tweets?.find((r: any) => r.type === "quoted")?.id ?? null;
    return {
      tweetId: t.id,
      requester: includes?.author?.(t)?.username ?? "",
      text: String(t.text ?? ""),
      targetUrl: urls[0] ?? null,
      mentionHasMedia: Boolean(t.attachments?.media_keys?.length),
      parentTweetId: parentId ? String(parentId) : null,
    };
  });

  return { mentions, newestId: res.meta?.newest_id ?? null };
}

export interface TweetVideo {
  tweetId: string;
  authorUsername: string;
  text: string;
  durationS: number | null;      // from the video media's duration_ms; null if X omits it
  possiblySensitive: boolean;    // X's own adult/sensitive flag — a hard gate for summon
  url: string;                   // canonical status URL to hand OpusClip as the source
}

/** Look up one tweet and its native video. Returns null when the tweet has no video media.
 *  This is the X-native summon path: everything the safety gate needs in one read. */
export async function fetchTweetVideo(tweetId: string): Promise<TweetVideo | null> {
  const client = await v2();
  const res: any = await withRetry(
    () => client.singleTweet(tweetId, {
      expansions: ["attachments.media_keys", "author_id"],
      "tweet.fields": ["possibly_sensitive", "text", "author_id", "attachments"],
      "media.fields": ["duration_ms", "type"],
      "user.fields": ["username"],
    }),
    { label: "x tweet video" },
  );
  const t = res?.data;
  if (!t) return null;
  const media: any[] = res?.includes?.media ?? [];
  const video = media.find((m: any) => m.type === "video");
  if (!video) return null;
  const author = (res?.includes?.users ?? []).find((u: any) => u.id === t.author_id);
  const username = author?.username ?? "i";
  return {
    tweetId: String(t.id),
    authorUsername: username,
    text: String(t.text ?? ""),
    durationS: video.duration_ms != null ? Math.round(Number(video.duration_ms) / 1000) : null,
    possiblySensitive: Boolean(t.possibly_sensitive),
    url: `https://x.com/${username}/status/${t.id}`,
  };
}

export { v2 as xReadV2 };
