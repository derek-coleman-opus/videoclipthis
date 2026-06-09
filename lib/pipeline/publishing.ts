import type { ProducedClip } from "./production";

export interface PublishResult {
  xPostId: string | null;
}

export interface Publisher {
  publish(clip: ProducedClip, replyTo?: string | null): Promise<PublishResult>;
}

export function xPublisher(): Publisher {
  return {
    async publish(clip, replyTo) {
      // TODO-LIVE: needs the four X tokens + an "Automated" account label; rate-limit summon replies.
      const { TwitterApi } = await import("twitter-api-v2");
      const client = new TwitterApi({
        appKey: process.env.X_API_KEY ?? "",
        appSecret: process.env.X_API_SECRET ?? "",
        accessToken: process.env.X_ACCESS_TOKEN ?? "",
        accessSecret: process.env.X_ACCESS_SECRET ?? "",
      });
      let mediaId: string | undefined;
      if (clip.clipUrl) {
        const buf = Buffer.from(await (await fetch(clip.clipUrl)).arrayBuffer());
        mediaId = await client.v1.uploadMedia(buf, { mimeType: "video/mp4" });
      }
      const payload: Record<string, unknown> = { text: clip.postText };
      if (mediaId) payload.media = { media_ids: [mediaId] };
      if (replyTo) payload.reply = { in_reply_to_tweet_id: replyTo };
      const res = await client.v2.tweet(payload as any);
      return { xPostId: res.data.id };
    },
  };
}
