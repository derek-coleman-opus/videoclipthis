// OpusClip API client (api.opus.pro). The real flow is project-based and asynchronous:
//   POST /api/clip-projects   → create a project from a long video (ClipAnything model)
//   GET  /api/clips           → the project's ranked, already-rendered clips (poll until ready)
// OpusClip renders the top clips as part of the project — there is no separate "render one
// segment" call — so we create once, poll, and pick the best ready clip.
//
// Auth is `Authorization: Bearer <API_KEY>`; rate limit is ~30 req/min. The exact request/response
// field NAMES are not all public (closed beta), so we send the documented shape and read clips
// defensively across the likely aliases. TODO-CONFIRM these against the api.opus.pro MCP, then
// tighten — the field-name fallbacks below localize any change.

import { sleep, slog, withRetry } from "./util";

export interface OpusClipResult {
  startS: number;
  endS: number;
  score: number;   // virality score (0-100)
  caption: string; // suggested hook/title
  clipUrl: string; // rendered clip download/preview URL (9:16, captioned)
  costUsd: number; // per-clip cost if the API reports it, else 0
}

const DEFAULT_BASE = "https://api.opus.pro";
const POLL_TIMEOUT_MS = 12 * 60 * 1000; // renders can take several minutes
const POLL_START_MS = 3000;
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

/** Create a clip project for a long video and return its id. */
async function createProject(videoUrl: string, apiKey: string, base: string): Promise<string> {
  const data = await opusFetch("POST", "/api/clip-projects", apiKey, base, {
    videoUrl,                       // source long-form video
    clipModel: "ClipAnything",      // multimodal model (vs ClipBasic)
    renderPreferences: { aspectRatio: "9:16", captions: true },
  });
  const proj = data.project ?? data.data ?? data;
  const id = String(proj?.id ?? proj?.projectId ?? proj?.project_id ?? "");
  if (!id) throw new Error(`OpusClip: no project id in create response: ${JSON.stringify(data).slice(0, 300)}`);
  return id;
}

function normalizeClip(c: any): OpusClipResult {
  return {
    startS: Number(c.start ?? c.start_s ?? c.startSeconds ?? c.startTime ?? 0),
    endS: Number(c.end ?? c.end_s ?? c.endSeconds ?? c.endTime ?? 0),
    score: Number(c.virality_score ?? c.viralityScore ?? c.score ?? 0),
    caption: String(c.hook ?? c.title ?? c.caption ?? c.name ?? ""),
    clipUrl: String(c.clipUrl ?? c.clip_url ?? c.downloadUrl ?? c.download_url ?? c.previewUrl ?? c.url ?? ""),
    costUsd: Number(c.cost_usd ?? c.costUsd ?? 0),
  };
}

/** Fetch a project's clips; `done` is true once rendering looks complete. */
async function listClips(
  projectId: string,
  apiKey: string,
  base: string,
): Promise<{ clips: OpusClipResult[]; done: boolean }> {
  const data = await opusFetch("GET", `/api/clips?projectId=${encodeURIComponent(projectId)}`, apiKey, base);
  const raw: any[] = data.clips ?? data.data ?? data.items ?? [];
  const clips = raw.map(normalizeClip);
  const status = String(data.status ?? data.project?.status ?? "").toLowerCase();
  const terminal = ["completed", "done", "succeeded", "finished", "ready"].includes(status);
  // Treat as done when the API signals completion, or every returned clip has a rendered URL.
  const done = terminal || (clips.length > 0 && clips.every((c) => c.clipUrl));
  return { clips, done };
}

/**
 * Create a project and poll until its clips are rendered; returns clips that have a usable URL,
 * ranked by virality score (best first). Throws on timeout so the caller marks the candidate failed.
 */
export async function opusclipClips(videoUrl: string, apiKey: string, base: string): Promise<OpusClipResult[]> {
  const projectId = await createProject(videoUrl, apiKey, base);
  slog("opusclip_project", { projectId, videoUrl });

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let delay = POLL_START_MS;
  while (Date.now() < deadline) {
    const { clips, done } = await listClips(projectId, apiKey, base);
    const ready = clips.filter((c) => c.clipUrl).sort((a, b) => b.score - a.score);
    if (done && ready.length) return ready;
    await sleep(delay);
    delay = Math.min(delay * 1.5, POLL_MAX_MS);
  }
  throw new Error(`OpusClip project ${projectId} not ready before timeout`);
}
