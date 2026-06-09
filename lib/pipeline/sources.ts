import { WATCHLIST, MAX_AGE_HOURS } from "./config";
import { FIGURES, type Figure } from "./figures";
import type { DetectedCandidate } from "./types";
import { withRetry } from "./util";
import { transcriptOrDescription } from "./transcript";

export interface Source {
  name: string;
  discover(): Promise<DetectedCandidate[]>;
}

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
      // Real captions when available; falls back to the description so the scorer always has signal.
      transcript: await transcriptOrDescription(v.id, v.snippet?.description ?? ""),
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
      transcript: await transcriptOrDescription(v.id, v.snippet?.description ?? ""),
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

export function buildSources(): Source[] {
  const sources: Source[] = [];
  if (WATCHLIST.youtubeChannels.length) {
    sources.push(youtubeSource(WATCHLIST.youtubeChannels, process.env.YOUTUBE_API_KEY ?? ""));
  }
  // TODO(M-next): podcast (RSS), X signal stream, HN, Reddit sources.
  return sources;
}
