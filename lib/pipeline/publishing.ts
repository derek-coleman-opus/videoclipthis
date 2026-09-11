import { slog } from "./util";
import type { ProducedClip } from "./production";

export interface PublishResult {
  xPostId: string | null;
}

export interface Publisher {
  publish(clip: ProducedClip, replyTo?: string | null): Promise<PublishResult>;
}

// X amplify_video hard cap is 512MB; we keep well under it. Guard so a runaway render can't
// stall an upload for minutes before X rejects it.
const MAX_CLIP_BYTES = 200 * 1024 * 1024;
// amplify_video ("longVideo") supports clips up to ~10 min; flip the flag past the 140s
// short-video boundary so X picks the right media category.
const LONG_VIDEO_THRESHOLD_S = 140;

/** Download the rendered clip into a Buffer, with a size guard. */
async function fetchClip(clipUrl: string): Promise<Buffer> {
  const res = await fetch(clipUrl);
  if (!res.ok) throw new Error(`fetch clip ${res.status}: ${clipUrl}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_CLIP_BYTES) {
    throw new Error(`clip too large for X: ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB`);
  }
  if (buf.byteLength === 0) throw new Error(`clip is empty: ${clipUrl}`);
  return buf;
}

/** Normalize twitter-api-v2 errors into clear messages; flag rate limits so callers can back off. */
function describeXError(e: unknown): Error {
  const err = e as { code?: number; rateLimit?: { reset?: number }; data?: unknown; message?: string };
  if (err?.code === 429) {
    const reset = err.rateLimit?.reset ? new Date(err.rateLimit.reset * 1000).toISOString() : "unknown";
    return new Error(`X rate limit hit (429); resets ${reset}`);
  }
  const detail = err?.data ? ` ${JSON.stringify(err.data)}` : "";
  return new Error(`X publish failed${err?.code ? ` (${err.code})` : ""}: ${err?.message ?? e}${detail}`);
}

/** True when a failed publish PROVABLY did not create a post on X.
 *
 *  The tweet call is non-idempotent: if X accepted the post and the RESPONSE was lost (timeout,
 *  connection reset, 5xx after the write), retrying publishes the same video a second time. So the
 *  caller must distinguish a rejection from an unknown outcome — marking an ambiguous failure
 *  "failed" invites a one-click retry that double-posts, which is how the same clip went out
 *  several times.
 *
 *  Provably not posted: a 4xx rejection (X refused the request outright), a rate limit (throttled
 *  before the write), and the local pre-flight failures that never reach X at all. Anything else —
 *  no status code, a network error, a 5xx — is AMBIGUOUS and must not be auto-retried. */
export function publishProvablyNotPosted(e: unknown): boolean {
  const m = (e as Error)?.message ?? String(e);
  // Local pre-flight: the clip never left this process.
  if (/clip too large for X|clip is empty:|fetch clip \d{3}:/.test(m)) return true;
  if (/X rate limit hit \(429\)/.test(m)) return true;
  const code = /X publish failed \((\d{3})\)/.exec(m)?.[1];
  return code ? Number(code) >= 400 && Number(code) < 500 : false;
}

export function xPublisher(): Publisher {
  return {
    async publish(clip, replyTo) {
      const { TwitterApi, EUploadMimeType } = await import("twitter-api-v2");
      const client = new TwitterApi({
        appKey: process.env.X_API_KEY ?? "",
        appSecret: process.env.X_API_SECRET ?? "",
        accessToken: process.env.X_ACCESS_TOKEN ?? "",
        accessSecret: process.env.X_ACCESS_SECRET ?? "",
      });

      try {
        let mediaId: string | undefined;
        if (clip.clipUrl) {
          const buf = await fetchClip(clip.clipUrl);
          const longVideo = clip.durationS > LONG_VIDEO_THRESHOLD_S;
          // uploadMedia chunks the upload AND polls media STATUS until processing finishes
          // (or throws if X reports the video failed processing) before we tweet.
          mediaId = await client.v1.uploadMedia(buf, {
            mimeType: EUploadMimeType.Mp4,
            longVideo,
          });
        }

        const payload: Record<string, unknown> = { text: clip.postText };
        if (mediaId) payload.media = { media_ids: [mediaId] };
        if (replyTo) payload.reply = { in_reply_to_tweet_id: replyTo };
        const res = await client.v2.tweet(payload as any);

        // The source link rides in a follow-up reply instead of the post body: a URL in the body
        // costs reach, and the credit-first promise only needs the link to be one tap away.
        // Best-effort — the clip post is already live and counted, so a failed follow-up is
        // logged and swallowed rather than failing (and re-queueing) a successful publish.
        if (clip.followUpText) {
          try {
            await client.v2.tweet({
              text: clip.followUpText,
              reply: { in_reply_to_tweet_id: res.data.id },
            } as any);
          } catch (e) {
            slog("followup_reply_failed", { xPostId: res.data.id, error: (e as Error).message });
          }
        }
        return { xPostId: res.data.id };
      } catch (e) {
        throw describeXError(e);
      }
    },
  };
}
