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

/** Context that sharpens the curation prompt for a specific video. */
export interface CurationContext {
  title?: string;
  speaker?: string;
  channel?: string;
}

/** What we tell ClipAnything to look for. The output is posted as native video on X to an
 *  audience of AI/dev builders, so we optimize for a scroll-stopping, self-contained moment. */
export function buildCurationPrompt(ctx: CurationContext = {}): string {
  const who = ctx.speaker ? ` from ${ctx.speaker}` : "";
  const what = ctx.title ? ` of "${ctx.title}"` : "";
  return [
    `Find the single most engaging AND informative moment${what}${who} for an audience of AI engineers and developers on X (Twitter).`,
    `Prioritize, in order: (1) a bold or surprising claim, hot take, or strong opinion; (2) a new announcement, release, or number; (3) a live demo moment; (4) a sharp, quotable insight or framework the viewer can apply.`,
    `The clip must be fully self-contained: it starts at the beginning of a thought and ends at its natural conclusion — never cut mid-sentence and never depend on context the viewer hasn't seen.`,
    `The first 2-3 seconds must work as a hook for someone scrolling a feed with sound off — a strong spoken opening line, not a slow wind-up.`,
    `Reject boring segments: skip stretches where the speaker is only reading slides, narrating a roadmap, or where nothing surprising is said. The chosen moment must stand on the strength of what is SPOKEN, not the visuals (the source is often just slides or a whiteboard).`,
    `Avoid: intros, speaker introductions, thank-yous, audience Q&A logistics, sponsor reads, and generic high-level summaries.`,
    `Format for X: vertical 9:16, with accurate burned-in captions (most viewers watch muted), 30-90 seconds long.`,
  ].join(" ");
}

/** The exact POST /api/clip-projects body. Field shapes verified against OpusClip's own CLI
 *  (github.com/opus-pro/opus-skills): clipDurations is an array of [min,max] second ranges,
 *  layoutAspectRatio is portrait|landscape|square (NOT "9:16"). Shared with the debug probe so
 *  the two never drift. */
export function buildCreateProjectBody(
  videoUrl: string,
  ctx: CurationContext = {},
  brandTemplateId?: string | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    videoUrl,
    curationPref: {
      // ClipAnything = the multimodal model; customPrompt is honored only on ClipAnything.
      model: "ClipAnything",
      // [min,max] second ranges — keep clips in the X-friendly 20–90s band.
      clipDurations: [[20, 90]],
      customPrompt: buildCurationPrompt(ctx),
    },
    renderPref: {
      layoutAspectRatio: "portrait", // 9:16 vertical
      quickstartConfig: { enableRemoveFillerWords: true },
    },
  };
  // A brand template (configured in the OpusClip dashboard) drives the vertical layout + caption
  // style — the reliable way to make slide-heavy talks fit the frame instead of cropping.
  if (brandTemplateId) body.brandTemplateId = brandTemplateId;
  return body;
}

/** Submit a long video for clipping; returns the project id (rendering continues server-side). */
export async function opusclipCreateProject(
  videoUrl: string,
  apiKey: string,
  base: string,
  ctx: CurationContext = {},
  brandTemplateId?: string | null,
): Promise<string> {
  const data = await opusFetch("POST", "/api/clip-projects", apiKey, base, buildCreateProjectBody(videoUrl, ctx, brandTemplateId));
  const proj = data.data ?? data.project ?? data;
  const id = String(proj?.id ?? proj?.projectId ?? "");
  if (!id) throw new Error(`OpusClip: no project id in create response: ${JSON.stringify(data).slice(0, 300)}`);
  return id;
}

function asArray(data: any): any[] {
  if (Array.isArray(data)) return data;
  return data?.data?.list ?? (Array.isArray(data?.data) ? data.data : null) ?? data?.clips ?? data?.list ?? [];
}

// Field names verified against OpusClip's CLI clip schema: the rendered MP4 is `uriForExport`,
// and a clip is still rendering when `renderAsVideoFile.pending === true` (NOT a top-level
// `render_pending`). durationMs is the clip length; source start/end isn't exposed, and we post
// the rendered file (not a time range), so start/end are cosmetic — derive from duration.
function normalizeClip(c: any): OpusClipResult {
  const durationS = c.durationMs != null ? Number(c.durationMs) / 1000 : Number(c.duration_sec ?? c.durationSec ?? 0);
  return {
    startS: 0,
    endS: durationS,
    score: Number(c.score ?? c.judgeResult?.hookScore ?? 0),
    caption: String(c.title ?? c.description ?? ""),
    clipUrl: String(c.uriForExport ?? c.export_url ?? ""),
    costUsd: 0,
    renderPending: Boolean(c.renderAsVideoFile?.pending ?? false),
  };
}

/** One status check on a project's exportable clips (may be empty/partial mid-render).
 *  `done` = at least one clip has finished rendering (has a usable export URL, not pending). */
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
  const done = clips.some((c) => c.clipUrl && !c.renderPending);
  return { clips, done };
}
