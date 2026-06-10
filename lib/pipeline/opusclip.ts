// OpusClip API client — confirmed against the public API reference
// (help.opus.pro/api-reference + github.com/opus-pro/opus-skills):
//   POST /api/clip-projects                                  → create a project from a video URL
//   GET  /api/exportable-clips?q=findByProjectId&projectId=… → the project's rendered clips
// Auth: `Authorization: Bearer <API_KEY>`. Rate limit 30 req/min; max video 10h/30GB; max 50
// concurrent projects; projects expire in 30 days. Completion is signaled by the exportable-clips
// array populating with `uriForExport` URLs (no documented stage enum), so we poll with backoff.
// Billing is credit-based (GET /api/api-usage?q=mine) — no per-clip USD, so costUsd stays 0 and
// volume control lives in MAX_CLIPS_PER_RUN.

import { sleep, slog, withRetry } from "./util";

export interface OpusClipResult {
  startS: number;
  endS: number;
  score: number;   // virality score (0-99)
  caption: string; // clip title (used as the hook)
  clipUrl: string; // rendered clip export URL (MP4)
  costUsd: number; // credit-based billing — always 0 here
}

const DEFAULT_BASE = "https://api.opus.pro";
const POLL_TIMEOUT_MS = 15 * 60 * 1000; // long videos can take a while to curate + render
const POLL_START_MS = 5000;
const POLL_MAX_MS = 30000;

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

/** Create a clip project for a long video and return its project id. */
async function createProject(videoUrl: string, apiKey: string, base: string): Promise<string> {
  const data = await opusFetch("POST", "/api/clip-projects", apiKey, base, {
    videoUrl,
    // ClipAnything = the multimodal curation model (vs ClipBasic for plain talking heads).
    // TODO-CONFIRM the exact enum value with the API team; drop `model` to use the org default.
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

function normalizeClip(c: any): OpusClipResult & { renderPending: boolean } {
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

/** Fetch a project's exportable clips (may be empty/partial while curation+render is in flight). */
async function listClips(projectId: string, apiKey: string, base: string): Promise<ReturnType<typeof normalizeClip>[]> {
  const data = await opusFetch(
    "GET",
    `/api/exportable-clips?q=findByProjectId&projectId=${encodeURIComponent(projectId)}`,
    apiKey,
    base,
  );
  return asArray(data).map(normalizeClip);
}

/**
 * Create a project and poll exportable-clips until rendered; returns clips with a usable export
 * URL ranked by virality score (best first). On timeout, returns whatever is ready, else throws
 * so the caller marks the candidate failed.
 */
export async function opusclipClips(videoUrl: string, apiKey: string, base: string): Promise<OpusClipResult[]> {
  const projectId = await createProject(videoUrl, apiKey, base);
  slog("opusclip_project", { projectId, videoUrl });

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let delay = POLL_START_MS;
  let ready: OpusClipResult[] = [];
  while (Date.now() < deadline) {
    const clips = await listClips(projectId, apiKey, base);
    ready = clips
      .filter((c) => c.clipUrl && !c.renderPending)
      .sort((a, b) => b.score - a.score)
      .map(({ renderPending: _r, ...c }) => c);
    // Done when every returned clip has finished rendering (and there is at least one).
    if (clips.length > 0 && ready.length === clips.length) return ready;
    await sleep(delay);
    delay = Math.min(delay * 1.5, POLL_MAX_MS);
  }
  if (ready.length) return ready; // partial render at timeout — use what's done
  throw new Error(`OpusClip project ${projectId} produced no exportable clips before timeout`);
}
