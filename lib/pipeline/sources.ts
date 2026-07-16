import { WATCHLIST, MAX_AGE_HOURS } from "./config";
import { type Figure } from "./figures";
import type { DetectedCandidate } from "./types";
import { withRetry } from "./util";
import { transcriptOrDescription } from "./transcript";

export interface Source {
  name: string;
  discover(): Promise<DetectedCandidate[]>;
}

const YT_API = "https://www.googleapis.com/youtube/v3";
const LONG_FORM_MIN_S = 8 * 60; // ignore anything shorter than ~8 min

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

// CJK, Hangul, Cyrillic, Arabic, Hebrew, Devanagari, Thai — if the title leans on these,
// the video isn't for our English-speaking audience.
const NON_LATIN = /[Ѐ-ӿ֐-׿؀-ۿऀ-ॿ฀-๿぀-ヿ㐀-鿿가-힯]/g;

/** English-only gate: trust YouTube's language metadata when present, else require a
 *  (mostly) Latin-script title. Keeps the account's clips consistently English. */
function isEnglish(v: any): boolean {
  const lang = String(v.snippet?.defaultAudioLanguage ?? v.snippet?.defaultLanguage ?? "").toLowerCase();
  if (lang) return lang.startsWith("en");
  const title: string = v.snippet?.title ?? "";
  if (!title) return false;
  const nonLatin = (title.match(NON_LATIN) ?? []).length;
  return nonLatin <= title.length * 0.1;
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
    if (!isEnglish(v)) continue;
    const published = v.snippet?.publishedAt ? new Date(v.snippet.publishedAt) : null;
    if (published && published.getTime() < cutoff) continue;
    out.push({
      source: "youtube",
      url: `https://youtu.be/${v.id}`,
      videoId: v.id,
      title: v.snippet?.title ?? "",
      // The channel is NOT the speaker — a brand credit ("Loved NVIDIA's talk") never earns a
      // reshare. The scorer extracts the human speaker from title/transcript; unattributed
      // clips are held by the credit-first gate.
      speaker: "",
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
    publishedAfter: cutoffISO, maxResults: "5", relevanceLanguage: "en",
  }, apiKey);
  const ids: string[] = (s.items ?? []).map((it: any) => it.id?.videoId).filter(Boolean);
  if (!ids.length) return [];
  const vids = await ytGet("videos", { part: "snippet,contentDetails", id: ids.join(",") }, apiKey);
  const lastName = (figure.name.split(" ").pop() ?? figure.name).toLowerCase();
  const out: DetectedCandidate[] = [];
  for (const v of vids.items ?? []) {
    const dur = parseDuration(v.contentDetails?.duration ?? "PT0S");
    if (dur < LONG_FORM_MIN_S) continue;
    if (!isEnglish(v)) continue;
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

/** Recent long-form videos matching a topic/keyword, from ANYONE. No speaker credit is known up
 *  front — runScout's matchFigure may still resolve one from the title; otherwise it's held. */
async function searchTopicVideos(topic: string, apiKey: string, cutoffISO: string): Promise<DetectedCandidate[]> {
  const s = await ytGet("search", {
    part: "snippet", q: topic, type: "video", order: "date",
    publishedAfter: cutoffISO, maxResults: "5", relevanceLanguage: "en",
  }, apiKey);
  const ids: string[] = (s.items ?? []).map((it: any) => it.id?.videoId).filter(Boolean);
  if (!ids.length) return [];
  const vids = await ytGet("videos", { part: "snippet,contentDetails", id: ids.join(",") }, apiKey);
  const out: DetectedCandidate[] = [];
  for (const v of vids.items ?? []) {
    const dur = parseDuration(v.contentDetails?.duration ?? "PT0S");
    if (dur < LONG_FORM_MIN_S) continue;
    if (!isEnglish(v)) continue;
    out.push({
      source: "youtube",
      url: `https://youtu.be/${v.id}`,
      videoId: v.id,
      title: v.snippet?.title ?? "",
      speaker: "", // never the channel/brand — the scorer extracts the human speaker
      channel: v.snippet?.channelTitle ?? "",
      durationS: dur,
      publishedAt: v.snippet?.publishedAt ? new Date(v.snippet.publishedAt) : null,
      signalStrength: 0.4,
      transcript: await transcriptOrDescription(v.id, v.snippet?.description ?? ""),
    });
  }
  return out;
}

/** A figure-name or topic/keyword to search YouTube for. */
export interface SearchTerm {
  term: string;
  figure?: Figure; // present → credit + tag this figure; absent → topic search
}

/** Search config for one run: which terms, how many to spend this burst, and where to start
 *  (rotated across runs so the whole list is covered over a day within quota). */
export interface SearchPlan {
  terms: SearchTerm[];
  budget: number;
  offset: number;
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

/** Watches org channels (WATCHLIST) + tracked figures' channels for fresh long-form uploads, and
 *  (when a search plan is given) runs a rotated window of figure/topic searches within budget. */
export function youtubeSource(
  channels: { name: string; handle?: string }[],
  apiKey: string,
  figures: Figure[],
  search: SearchPlan | null,
): Source {
  return {
    name: "youtube",
    async discover() {
      if (!apiKey) return [];
      const ids = new Set<string>();
      for (const c of channels) {
        const id = await resolveChannelId(c, apiKey);
        if (id) ids.add(id);
      }
      for (const f of figures) if (f.youtubeChannelId) ids.add(f.youtubeChannelId);
      const all: DetectedCandidate[] = [];
      for (const id of ids) {
        try {
          all.push(...(await recentUploads(id, apiKey)));
        } catch (e) {
          console.warn(`youtube channel ${id} failed: ${(e as Error).message}`);
        }
      }

      // Search vector: figures (credited) + topics/keywords (uncredited). Each search.list call
      // costs 100 quota units, so only a rotating `budget`-sized window runs per burst.
      if (search && search.terms.length) {
        const n = search.terms.length;
        const start = ((search.offset % n) + n) % n;
        const window = Array.from({ length: Math.min(search.budget, n) }, (_, i) => search.terms[(start + i) % n]);
        const cutoffISO = new Date(Date.now() - MAX_AGE_HOURS * 3600 * 1000).toISOString();
        for (const t of window) {
          try {
            all.push(...(t.figure
              ? await searchFigureVideos(t.figure, apiKey, cutoffISO)
              : await searchTopicVideos(t.term, apiKey, cutoffISO)));
          } catch (e) {
            console.warn(`youtube search "${t.term}" failed: ${(e as Error).message}`);
          }
        }
      }
      // TODO-LIVE: add WebSub/PubSubHubbub push for near-real-time detection (build plan §3.1).
      return all;
    },
  };
}

export function buildSources(
  figures: Figure[],
  opts?: { channels?: { name: string; handle?: string }[]; search?: SearchPlan | null },
): Source[] {
  // Settings-provided channels (the admin "Watched channels" field) override the code
  // WATCHLIST, so self-hosters can point the bot at their niche without a deploy.
  const channels = opts?.channels?.length ? opts.channels : WATCHLIST.youtubeChannels;
  const sources: Source[] = [];
  if (channels.length) {
    sources.push(youtubeSource(channels, process.env.YOUTUBE_API_KEY ?? "", figures, opts?.search ?? null));
  }
  // TODO(M-next): podcast (RSS), X signal stream, HN, Reddit sources.
  return sources;
}

/** Per-channel discovery diagnostics: resolved id + how many uploads survive each filter, at a
 *  configurable recency window. Powers /api/debug/youtube so "0 videos" has a precise cause. */
export interface ChannelReport {
  name: string;
  handle?: string;
  resolvedId: string | null;
  rawUploads: number;
  passedLongForm: number;
  passedEnglish: number;
  passedRecency: number;
  kept: { title: string; durationS: number; publishedAt: string | null }[];
  dropped: { title: string; reason: string }[];
  error?: string;
}

export async function youtubeChannelReport(
  channels: { name: string; handle?: string }[],
  apiKey: string,
  hours: number,
): Promise<ChannelReport[]> {
  const cutoff = Date.now() - hours * 3600 * 1000;
  const reports: ChannelReport[] = [];
  for (const c of channels) {
    const rep: ChannelReport = {
      name: c.name, handle: c.handle, resolvedId: null,
      rawUploads: 0, passedLongForm: 0, passedEnglish: 0, passedRecency: 0, kept: [], dropped: [],
    };
    try {
      rep.resolvedId = await resolveChannelId(c, apiKey);
      if (!rep.resolvedId) { rep.error = "could not resolve channel id (bad handle/name?)"; reports.push(rep); continue; }
      const ch = await ytGet("channels", { part: "contentDetails", id: rep.resolvedId }, apiKey);
      const uploads: string | undefined = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads) { rep.error = "channel has no uploads playlist"; reports.push(rep); continue; }
      const pl = await ytGet("playlistItems", { part: "contentDetails", playlistId: uploads, maxResults: "10" }, apiKey);
      const ids: string[] = (pl.items ?? []).map((it: any) => it.contentDetails?.videoId).filter(Boolean);
      if (!ids.length) { rep.error = "uploads playlist empty"; reports.push(rep); continue; }
      const vids = await ytGet("videos", { part: "snippet,contentDetails", id: ids.join(",") }, apiKey);
      rep.rawUploads = (vids.items ?? []).length;
      for (const v of vids.items ?? []) {
        const dur = parseDuration(v.contentDetails?.duration ?? "PT0S");
        const title: string = v.snippet?.title ?? "";
        if (dur < LONG_FORM_MIN_S) { rep.dropped.push({ title, reason: `too short (${Math.round(dur / 60)}min < ${LONG_FORM_MIN_S / 60}min)` }); continue; }
        rep.passedLongForm++;
        if (!isEnglish(v)) { rep.dropped.push({ title, reason: "not English" }); continue; }
        rep.passedEnglish++;
        const published = v.snippet?.publishedAt ? new Date(v.snippet.publishedAt) : null;
        if (published && published.getTime() < cutoff) {
          rep.dropped.push({ title, reason: `older than ${hours}h (${published.toISOString().slice(0, 10)})` });
          continue;
        }
        rep.passedRecency++;
        rep.kept.push({ title, durationS: dur, publishedAt: published?.toISOString() ?? null });
      }
    } catch (e) {
      rep.error = (e as Error).message;
    }
    reports.push(rep);
  }
  return reports;
}
