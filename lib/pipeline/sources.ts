import { WATCHLIST } from "./config";
import { FIGURES } from "./figures";
import type { DetectedCandidate } from "./types";
import { withRetry } from "./util";

export interface Source {
  name: string;
  discover(): Promise<DetectedCandidate[]>;
}

/** Deterministic demo source so the pipeline runs with no keys/network. */
export const mockSource: Source = {
  name: "mock",
  async discover() {
    return [
      {
        source: "youtube",
        url: "https://youtu.be/DEMO123",
        videoId: "DEMO123",
        title: "The Future of Coding Agents",
        speaker: "A. Researcher",
        speakerHandle: "airesearcher",
        channel: "Anthropic",
        event: "AI Engineer Summit",
        durationS: 3012,
        signalStrength: 0.8,
        transcript:
          "... the thing nobody expects is that agents will write most code by 2027 ... " +
          "here's the demo where Claude refactors a 200k-line repo live ...",
      },
      {
        source: "youtube",
        url: "https://youtu.be/SKIP456",
        videoId: "SKIP456",
        title: "Weekly channel update #214",
        speaker: "Some Creator",
        speakerHandle: "",
        channel: "Random Vlog",
        durationS: 600,
        signalStrength: 0.1,
        transcript: "hey everyone welcome back to the channel, smash that like button ...",
      },
      {
        // No speakerHandle from the source — but because we TRACK this figure,
        // matchFigure() resolves the @ so the clip is creditable + tagged.
        source: "youtube",
        url: "https://youtu.be/KARP99",
        videoId: "KARP99",
        title: "Andrej Karpathy on the future of LLM agents",
        speaker: "Andrej Karpathy",
        speakerHandle: "",
        channel: "AI Engineer",
        event: "AI Engineer Summit",
        durationS: 2800,
        signalStrength: 0.9,
        transcript: "... agents are the new abstraction, here's a live demo ...",
      },
    ];
  },
};

const YT_API = "https://www.googleapis.com/youtube/v3";
const LONG_FORM_MIN_S = 12 * 60; // ignore anything shorter than ~12 min
const RECENT_HOURS = 48;          // only surface fresh drops (first-to-clip)

async function ytGet(path: string, params: Record<string, string>, apiKey: string): Promise<any> {
  const url = new URL(`${YT_API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", apiKey);
  return withRetry(async () => {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`YouTube ${path} ${res.status}: ${await res.text()}`);
    return res.json();
  }, { label: `youtube ${path}` });
}

function parseDuration(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** Fresh, long-form uploads from one channel (uploads playlist → durations → recency filter). */
async function recentUploads(channelId: string, apiKey: string): Promise<DetectedCandidate[]> {
  const ch = await ytGet("channels", { part: "contentDetails", id: channelId }, apiKey);
  const uploads: string | undefined = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return [];
  const pl = await ytGet("playlistItems", { part: "contentDetails", playlistId: uploads, maxResults: "10" }, apiKey);
  const ids: string[] = (pl.items ?? []).map((it: any) => it.contentDetails?.videoId).filter(Boolean);
  if (!ids.length) return [];
  const vids = await ytGet("videos", { part: "snippet,contentDetails", id: ids.join(",") }, apiKey);
  const cutoff = Date.now() - RECENT_HOURS * 3600 * 1000;
  const out: DetectedCandidate[] = [];
  for (const v of vids.items ?? []) {
    const dur = parseDuration(v.contentDetails?.duration ?? "PT0S");
    if (dur < LONG_FORM_MIN_S) continue;
    const published = v.snippet?.publishedAt ? new Date(v.snippet.publishedAt) : null;
    if (published && published.getTime() < cutoff) continue;
    out.push({
      source: "youtube",
      url: `https://youtu.be/${v.id}`,
      videoId: v.id,
      title: v.snippet?.title ?? "",
      speaker: v.snippet?.channelTitle ?? "",
      channel: v.snippet?.channelTitle ?? "",
      durationS: dur,
      publishedAt: published,
      signalStrength: 0.5,
      // TODO-LIVE: fetch the real transcript (captions API or a timedtext/transcript service).
      // Description is a weak stand-in so the scorer has signal until transcripts are wired.
      transcript: v.snippet?.description ?? "",
    });
  }
  return out;
}

/** Watches org channels (WATCHLIST) + every tracked figure's channel for fresh long-form uploads. */
export function youtubeSource(channels: { name: string; channelId: string }[], apiKey: string): Source {
  return {
    name: "youtube",
    async discover() {
      if (!apiKey) return [];
      const ids = new Set<string>();
      for (const c of channels) if (c.channelId && c.channelId !== "TODO") ids.add(c.channelId);
      for (const f of FIGURES) if (f.youtubeChannelId) ids.add(f.youtubeChannelId);
      const all: DetectedCandidate[] = [];
      for (const id of ids) {
        try {
          all.push(...(await recentUploads(id, apiKey)));
        } catch (e) {
          console.warn(`youtube channel ${id} failed: ${(e as Error).message}`);
        }
      }
      // TODO-LIVE: add WebSub/PubSubHubbub push for near-real-time detection (build plan §3.1).
      return all;
    },
  };
}

export function buildSources(mock: boolean): Source[] {
  if (mock) return [mockSource];
  const sources: Source[] = [];
  if (WATCHLIST.youtubeChannels.length) {
    sources.push(youtubeSource(WATCHLIST.youtubeChannels, process.env.YOUTUBE_API_KEY ?? ""));
  }
  // TODO(M-next): podcast (RSS), X signal stream, HN, Reddit sources.
  return sources;
}
