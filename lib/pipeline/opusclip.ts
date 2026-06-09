// Minimal OpusClip API client. The exact endpoints/payloads are TODO-LIVE — confirm against
// api.opus.pro (and the live MCP at api.opus.pro/api/mcp). Kept tiny so swapping in the real
// request/response shapes is a localized change.

import { withRetry } from "./util";

export interface OpusSegment {
  startS: number;
  endS: number;
  score: number;   // virality score
  caption: string; // suggested hook
}

export interface OpusRender {
  clipUrl: string;
  costUsd: number;
}

async function opusFetch(path: string, body: unknown, apiKey: string, base: string): Promise<any> {
  return withRetry(async () => {
    const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`OpusClip ${path} ${res.status}: ${await res.text()}`);
    return res.json();
  }, { label: `opusclip ${path}` });
}

/** Find viral-worthy segments in a long video (ClipAnything + virality scoring). */
export async function opusclipAnalyze(videoUrl: string, apiKey: string, base: string): Promise<OpusSegment[]> {
  // TODO-LIVE: confirm endpoint + response shape; ClipAnything may be async (submit → poll).
  const data = await opusFetch("/v1/clipanything/analyze", { video_url: videoUrl }, apiKey, base);
  return (data.clips ?? data.segments ?? []).map((c: any) => ({
    startS: Number(c.start ?? c.start_s ?? 0),
    endS: Number(c.end ?? c.end_s ?? 0),
    score: Number(c.virality_score ?? c.score ?? 0),
    caption: String(c.hook ?? c.title ?? c.caption ?? ""),
  }));
}

/** Render a chosen segment to a captioned 9:16 clip (clip → reframe → caption → export). */
export async function opusclipRender(
  videoUrl: string, startS: number, endS: number, apiKey: string, base: string,
): Promise<OpusRender> {
  // TODO-LIVE: confirm endpoint + that this maps to clip/reframe/caption/export; may be async (poll).
  const data = await opusFetch(
    "/v1/clips/render",
    { video_url: videoUrl, start_s: startS, end_s: endS, aspect: "9:16", captions: true },
    apiKey, base,
  );
  return {
    clipUrl: String(data.clip_url ?? data.url ?? ""),
    costUsd: Number(data.cost_usd ?? 0),
  };
}
