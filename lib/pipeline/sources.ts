import { WATCHLIST, MAX_AGE_HOURS } from "./config";
import { FIGURES, type Figure } from "./figures";
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
  const cutoff = Date.now() - MAX_AGE_HOURS * 3600 * 1000;
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

/** Recent videos that FEATURE a tracked figure, posted by ANYONE (interviews, talks, reposts).
 *  We still credit + tag the figure since we know who we searched for. */
async function searchFigureVideos(figure: Figure, apiKey: string, cutoffISO: string): Promise<DetectedCandidate[]> {
  const s = await ytGet("search", {
    part: "snippet", q: `"${figure.name}"`, type: "video", order: "date",
    publishedAfter: cutoffISO, maxResults: "5",
  }, apiKey);
  const ids: string[] = (s.items ?? []).map((it: any) => it.id?.videoId).filter(Boolean);
  if (!ids.length) return [];
  const vids = await ytGet("videos", { part: "snippet,contentDetails", id: ids.join(",") }, apiKey);
  const lastName = (figure.name.split(" ").pop() ?? figure.name).toLowerCase();
  const out: DetectedCandidate[] = [];
  for (const v of vids.items ?? []) {
    const dur = parseDuration(v.contentDetails?.duration ?? "PT0S");
    if (dur < LONG_FORM_MIN_S) continue;
    const title: string = v.snippet?.title ?? "";
    if (!title.toLowerCase().includes(lastName)) continue; // light noise filter: name in title
    out.push({
      source: "youtube",
      url: `https://youtu.be/${v.id}`,
      videoId: v.id,
      title,
      speaker: figure.name,
      speakerHandle: figure.xHandle, // credit + tag the figure even though someone else posted it
      channel: v.snippet?.channelTitle ?? "",
      durationS: dur,
      publishedAt: v.snippet?.publishedAt ? new Date(v.snippet.publishedAt) : null,
      signalStrength: 0.6,
      figureName: figure.name,
      transcript: v.snippet?.description ?? "",
    });
  }
  return out;
}

/** Resolve a channel to its ID: exact handle if given, else search by name. Logs what it picked. */
async function resolveChannelId(c: { name: string; handle?: string }, apiKey: string): Promise<string | null> {
  try {
    if (c.handle) {
      const r = await ytGet("channels", { part: "id", forHandle: c.handle.replace(/^@/, "") }, apiKey);
      const id = r.items?.[0]?.id;
      if (id) return id;
    }
    const s = await ytGet("search", { part: "snippet", q: c.name, type: "channel", maxResults: "1" }, apiKey);
    const item = s.items?.[0];
    if (item?.id?.channelId) {
      console.log(`youtube: "${c.name}" -> ${item.snippet?.title} (${item.id.channelId})`);
      return item.id.channelId;
    }
    return null;
  } catch (e) {
    console.warn(`youtube: resolve "${c.name}" failed: ${(e as Error).message}`);
    return null;
  }
}

/** Watches org channels (WATCHLIST) + every tracked figure's channel for fresh long-form uploads. */
export function youtubeSource(channels: { name: string; handle?: string }[], apiKey: string): Source {
  return {
    name: "youtube",
    async discover() {
      if (!apiKey) return [];
      const ids = new Set<string>();
      for (const c of channels) {
        const id = await resolveChannelId(c, apiKey);
        if (id) ids.add(id);
      }
      for (const f of FIGURES) if (f.youtubeChannelId) ids.add(f.youtubeChannelId);
      const all: DetectedCandidate[] = [];
      for (const id of ids) {
        try {
          all.push(...(await recentUploads(id, apiKey)));
        } catch (e) {
          console.warn(`youtube channel ${id} failed: ${(e as Error).message}`);
        }
      }
      // Also catch videos that FEATURE a tracked figure but were posted by someone else
      // (interviews, talks, reposts) — search YouTube by the figure's name; still credited to them.
      const cutoffISO = new Date(Date.now() - MAX_AGE_HOURS * 3600 * 1000).toISOString();
      for (const f of FIGURES) {
        try {
          all.push(...(await searchFigureVideos(f, apiKey, cutoffISO)));
        } catch (e) {
          console.warn(`youtube figure search "${f.name}" failed: ${(e as Error).message}`);
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
