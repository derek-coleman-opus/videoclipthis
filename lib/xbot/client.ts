/** twitter-api-v2 clients bound to the PERSONAL account's app (XBOT_* env vars),
 *  kept fully separate from the @videoclipthis credentials in lib/pipeline. */

type TwitterApiClient = InstanceType<(typeof import("twitter-api-v2"))["TwitterApi"]>;

/** OAuth 1.0a user-context client — likes, replies, posts as the personal account. */
export async function xbotRw(): Promise<TwitterApiClient> {
  const { TwitterApi } = await import("twitter-api-v2");
  return new TwitterApi({
    appKey: process.env.XBOT_API_KEY ?? "",
    appSecret: process.env.XBOT_API_SECRET ?? "",
    accessToken: process.env.XBOT_ACCESS_TOKEN ?? "",
    accessSecret: process.env.XBOT_ACCESS_SECRET ?? "",
  });
}

/** App-only bearer client — search, timelines, metrics (Phase 3 discovery). */
export async function xbotRead(): Promise<TwitterApiClient> {
  const { TwitterApi } = await import("twitter-api-v2");
  return new TwitterApi(process.env.XBOT_BEARER_TOKEN ?? "");
}

/** Normalize twitter-api-v2 errors; surface rate-limit resets so callers can back off. */
export function describeXbotError(e: unknown): Error {
  const err = e as { code?: number; rateLimit?: { reset?: number }; data?: unknown; message?: string };
  if (err?.code === 429) {
    const reset = err.rateLimit?.reset ? new Date(err.rateLimit.reset * 1000).toISOString() : "unknown";
    return new Error(`X rate limit hit (429); resets ${reset}`);
  }
  const detail = err?.data ? ` ${JSON.stringify(err.data)}` : "";
  return new Error(`XBot X call failed${err?.code ? ` (${err.code})` : ""}: ${err?.message ?? e}${detail}`);
}

/** The personal account's own user id (needed for v2.like/follow), cached for the warm instance. */
let _xbotUserId: string | null = null;
export async function xbotUserId(): Promise<string> {
  if (_xbotUserId) return _xbotUserId;
  const client = await xbotRw();
  const me = await client.v2.me().catch((e) => { throw describeXbotError(e); });
  _xbotUserId = me.data.id;
  return _xbotUserId;
}
