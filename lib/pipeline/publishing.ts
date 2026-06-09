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
        return { xPostId: res.data.id };
      } catch (e) {
        throw describeXError(e);
      }
    },
  };
}
