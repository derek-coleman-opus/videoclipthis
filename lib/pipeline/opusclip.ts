// OpusClip API client (api.opus.pro) — confirmed against the published API reference:
//   POST /api/clip-projects                                  → create a project from a video URL
//   GET  /api/exportable-clips?q=findByProjectId&projectId=… → the project's rendered clips
// Auth: `Authorization: Bearer <API_KEY>`. Rate limit 30 req/min; max video 10h/30GB; max 50
// concurrent projects; projects expire in 30 days.
//
// Rendering takes minutes — far longer than a serverless function budget — so this client is
// deliberately TWO-PHASE with no internal polling: `opusclipCreateProject` submits and returns
// the project id immediately; `opusclipFetchClips` is a single cheap status check. The pipeline
// persists the project id on the candidate (status "rendering") and collects finished renders
// on subsequent runs (lib/pipeline/render.ts).
//
// Billing is credit-based (GET /api/api-usage?q=mine) — no per-clip USD, so costUsd stays 0 and
// volume control lives in MAX_CLIPS_PER_RUN.

import { withRetry } from "./util";

export interface OpusClipResult {
  startS: number;
  endS: number;
  score: number;   // virality score (0-99)
  caption: string; // clip title (used as the hook)
  clipUrl: string; // rendered clip export URL (MP4)
  costUsd: number; // credit-based billing — always 0 here
  renderPending: boolean;
}

const DEFAULT_BASE = "https://api.opus.pro";

async function opusFetch(
  method: "GET" | "POST",
  path: string,
  apiKey: string,
  base: string,
  body?: unknown,
): Promise<any> {
  const url = `${(base || DEFAULT_BASE).replace(/\/$/, "")}${path}`;
  return withRetry(
    async () => {
      const res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`OpusClip ${method} ${path} ${res.status}: ${await res.text()}`);
      return res.json();
    },
    { label: `opusclip ${method} ${path}` },
  );
}

/** Submit a long video for clipping; returns the project id (rendering continues server-side). */
export async function opusclipCreateProject(videoUrl: string, apiKey: string, base: string): Promise<string> {
  const data = await opusFetch("POST", "/api/clip-projects", apiKey, base, {
    videoUrl,
    // ClipAnything = the multimodal curation model (vs ClipBasic for plain talking heads).
    // TODO-CONFIRM the exact enum value against the OpenAPI spec; drop `model` for the org default.
    curationPref: { model: "ClipAnything", clipDurations: [30, 60, 90] },
    // TODO-CONFIRM the layoutAspectRatio enum (e.g. "9:16" vs a named value).
    renderPref: { layoutAspectRatio: "9:16" },
  });
  const proj = data.data ?? data.project ?? data;
  const id = String(proj?.id ?? proj?.projectId ?? "");
  if (!id) throw new Error(`OpusClip: no project id in create response: ${JSON.stringify(data).slice(0, 300)}`);
  return id;
}

function asArray(data: any): any[] {
  if (Array.isArray(data)) return data;
  return data?.data?.list ?? (Array.isArray(data?.data) ? data.data : null) ?? data?.clips ?? data?.list ?? [];
}

function normalizeClip(c: any): OpusClipResult {
  const durationS = c.durationMs != null ? Number(c.durationMs) / 1000 : Number(c.duration_sec ?? c.durationSec ?? 0);
  const startS = c.startMs != null ? Number(c.startMs) / 1000 : Number(c.start_sec ?? c.startSec ?? 0);
  return {
    startS,
    endS: c.endMs != null ? Number(c.endMs) / 1000 : startS + durationS,
    score: Number(c.score ?? c.judgeResult?.score ?? 0),
    caption: String(c.title ?? c.description ?? ""),
    clipUrl: String(c.uriForExport ?? c.export_url ?? c.exportUrl ?? c.downloadUrl ?? c.preview_url ?? ""),
    costUsd: 0,
    renderPending: Boolean(c.render_pending ?? c.renderPending ?? false),
  };
}

/** One status check on a project's exportable clips (may be empty/partial mid-render).
 *  `done` = at least one clip exists and every returned clip has finished rendering. */
export async function opusclipFetchClips(
  projectId: string,
  apiKey: string,
  base: string,
): Promise<{ clips: OpusClipResult[]; done: boolean }> {
  const data = await opusFetch(
    "GET",
    `/api/exportable-clips?q=findByProjectId&projectId=${encodeURIComponent(projectId)}`,
    apiKey,
    base,
  );
  const clips = asArray(data).map(normalizeClip);
  const done = clips.length > 0 && clips.every((c) => c.clipUrl && !c.renderPending);
  return { clips, done };
}
