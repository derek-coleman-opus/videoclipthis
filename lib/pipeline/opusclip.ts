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
// Billing is credit-based (GET /api/api-usage?q=mine) at roughly 1 credit per MINUTE OF SOURCE
// video, charged when the project is created — not when a clip is posted. So costUsd stays 0 and
// spend control lives in the submit-time caps in ./config (DAILY_SOURCE_MINUTES_CAP,
// RENDER_SUBMIT_MULTIPLIER, MAX_CLIPS_PER_RUN) plus the credit floor checked via opusclipUsage().

import { withRetry } from "./util";

export interface OpusClipResult {
  clipId: string;  // OpusClip's clip id — required for social post-tasks
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
  opts: { retry?: boolean } = {},
): Promise<any> {
  const url = `${(base || DEFAULT_BASE).replace(/\/$/, "")}${path}`;
  const once = async () => {
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
  };
  // Retry only what is safe to repeat. GETs are idempotent; a POST that creates a BILLED resource
  // is not — if the server created the project but the response was lost (timeout, 5xx after
  // create, connection reset), retrying charges for the same video again and only the last
  // project id is ever persisted, so the extra projects are invisible in the admin. Callers that
  // create resources retry at the candidate level instead (bounded by MAX_SUBMIT_ATTEMPTS).
  const retry = opts.retry ?? method === "GET";
  return retry ? withRetry(once, { label: `opusclip ${method} ${path}` }) : once();
}

// ── Plan usage (the credit meter that actually bills) ───────────────────────

export interface OpusUsage {
  /** Credits consumed in the current billing month. */
  used: number | null;
  /** Monthly credit allowance. */
  limit: number | null;
  /** limit - used, when both are known. */
  remaining: number | null;
  /** True when the workspace is exempt from caps — treat as unlimited headroom. */
  uncapped: boolean;
}

/** Read the org's credit meter. Field names vary across response shapes, so pick defensively and
 *  return nulls rather than guessing — callers must treat an unknown shape as "no signal", never
 *  as "no credits left". */
export async function opusclipUsage(apiKey: string, base: string): Promise<OpusUsage> {
  const data = await opusFetch("GET", "/api/api-usage?q=mine", apiKey, base);
  const d = data?.data ?? data ?? {};
  const monthly = d.monthly ?? d.month ?? d;
  const num = (v: unknown): number | null =>
    v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v);

  const used = num(monthly?.used ?? monthly?.usedCredits ?? monthly?.creditsUsed);
  const limit = num(monthly?.limit ?? monthly?.quota ?? monthly?.creditLimit);
  const remainingRaw = num(monthly?.remaining ?? monthly?.creditsRemaining);
  return {
    used,
    limit,
    remaining: remainingRaw ?? (used != null && limit != null ? limit - used : null),
    uncapped: Boolean(d.uncapped ?? monthly?.uncapped ?? false),
  };
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
    `Find the single most ARGUABLE moment${what}${who} for an audience of AI engineers and developers on X (Twitter).`,
    `The bar is not "informative" — it is whether a working developer would stop scrolling and reply to it. Prioritize, in order: (1) a specific, falsifiable claim — a number, a benchmark, a named tool, a tradeoff, a prediction with a date, or an admission that something does not work; (2) a contrarian or surprising opinion that cuts against what this audience already believes; (3) a live demo or a concrete war story from real work; (4) a sharp, quotable framework.`,
    `The moment must open on the CLAIM ITSELF. The first spoken sentence should be the strong statement, not the wind-up to it — someone scrolling with sound off reads the caption of the first 2 seconds and decides there.`,
    `The clip must be fully self-contained: it starts at the beginning of a thought and ends at its natural conclusion — never cut mid-sentence and never depend on context the viewer hasn't seen.`,
    `Reject boring segments even if they are the best available: slide reading, roadmap or feature narration, definitions of things this audience knows, agreeable consensus nobody would reply to, and motivational or futurist filler ("AI will change everything"). It is better to return a shorter, sharper moment than a well-delivered but unarguable one.`,
    `When the source shows a concrete artifact on screen — a terminal, an editor, code, a benchmark chart, a live demo — prefer a moment where that artifact is visible; those clips carry far better than a talking head. Where the source is only slides or a whiteboard, the moment must stand entirely on what is SPOKEN.`,
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

/** True when a failed create PROVABLY did not bill us, so re-submitting is safe.
 *
 *  opusFetch throws `OpusClip POST /path <status>: <body>` only after the server answered. A 4xx
 *  means the request was rejected outright — nothing was created, so a retry is free (429 included:
 *  rate-limited, not charged). Anything else (timeout, connection reset, 5xx) is AMBIGUOUS: the
 *  project may already exist and be billed while we never saw its id, so those must not be
 *  retried — that is precisely how one video becomes several charges. */
export function createProvablyNotBilled(e: unknown): boolean {
  const m = (e as Error)?.message ?? String(e);
  const status = /\s(\d{3}):/.exec(m)?.[1];
  return status ? Number(status) >= 400 && Number(status) < 500 : false;
}

/** True when a create failed because the ACCOUNT is out of render budget — nothing is wrong with
 *  this candidate, and every other submit in the run will fail identically.
 *
 *  OpusClip answers `402 InsufficientCreditError` ("not enough credits to cover your video
 *  length … purchase more hours"). This is a DIFFERENT METER from GET /api/api-usage, which
 *  reports the API rate cap: the cap can read tens of thousands of credits remaining while the
 *  plan's render balance is empty. That is why the pre-flight MIN_CREDITS_REMAINING gate cannot
 *  see this coming, and why the caller must treat it as an account condition rather than a
 *  per-candidate failure. */
export function isAccountCreditError(e: unknown): boolean {
  const m = (e as Error)?.message ?? String(e);
  return /\s402:/.test(m) || /InsufficientCredit/i.test(m);
}

/** Submit a long video for clipping; returns the project id (rendering continues server-side). */
export async function opusclipCreateProject(
  videoUrl: string,
  apiKey: string,
  base: string,
  ctx: CurationContext = {},
  brandTemplateId?: string | null,
): Promise<string> {
  const data = await opusFetch(
    "POST", "/api/clip-projects", apiKey, base,
    buildCreateProjectBody(videoUrl, ctx, brandTemplateId),
    { retry: false }, // billed + non-idempotent — never auto-repeat (see opusFetch)
  );
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
    clipId: String(c.id ?? c.clipId ?? c.curationId ?? ""),
    startS: 0,
    endS: durationS,
    score: Number(c.score ?? c.judgeResult?.hookScore ?? 0),
    caption: String(c.title ?? c.description ?? ""),
    clipUrl: String(c.uriForExport ?? c.export_url ?? ""),
    costUsd: 0,
    renderPending: Boolean(c.renderAsVideoFile?.pending ?? false),
  };
}

// ── Social posting (cross-platform distribution) ────────────────────────────
// GET /social-accounts?q=mine lists the accounts connected in the OpusClip dashboard;
// POST /post-tasks publishes an already-rendered clip to one of them instantly.
// Shapes verified against the published API reference (opus-skills api-reference.md).

export interface OpusSocialAccount {
  postAccountId: string;
  subAccountId: string | null; // required for Facebook/Instagram/LinkedIn posts
  platform: string;            // YOUTUBE|TIKTOK_BUSINESS|FACEBOOK_PAGE|INSTAGRAM_BUSINESS|LINKEDIN|TWITTER
  name: string;                // extUserName
}

/** Social accounts connected in the OpusClip dashboard (Settings → Social accounts). */
export async function opusclipListSocialAccounts(
  apiKey: string,
  base: string,
): Promise<OpusSocialAccount[]> {
  const data = await opusFetch("GET", "/api/social-accounts?q=mine", apiKey, base);
  const list = Array.isArray(data?.data) ? data.data : asArray(data);
  return list.map((a: any) => ({
    postAccountId: String(a.postAccountId ?? ""),
    subAccountId: a.subAccountId ? String(a.subAccountId) : null,
    platform: String(a.platform ?? ""),
    name: String(a.extUserName ?? a.extUserId ?? ""),
  })).filter((a: OpusSocialAccount) => a.postAccountId && a.platform);
}

/** Publish a rendered clip to one connected account right now. Returns the task id when the
 *  API provides one. Rate limit: 1 req/s — callers publishing to several accounts must pace. */
export async function opusclipCreatePostTask(
  args: {
    projectId: string;
    clipId: string;
    postAccountId: string;
    subAccountId?: string | null;
    title: string;
    description: string;
  },
  apiKey: string,
  base: string,
): Promise<string | null> {
  const body: Record<string, unknown> = {
    projectId: args.projectId,
    clipId: args.clipId,
    postAccountId: args.postAccountId,
    postDetail: {
      title: args.title,
      custom: { description: args.description, privacy: "public" },
    },
  };
  if (args.subAccountId) body.subAccountId = args.subAccountId;
  // Non-idempotent: a retry publishes the clip twice to the same account.
  const data = await opusFetch("POST", "/api/post-tasks", apiKey, base, body, { retry: false });
  const task = data?.data ?? data;
  return task?.taskId ? String(task.taskId) : task?.id ? String(task.id) : null;
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
