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
import { AI_DEVELOPER } from "./audience";

export interface OpusClipResult {
  clipId: string;  // OpusClip's clip id — required for social post-tasks
  startS: number;
  endS: number;
  score: number;   // virality score (0-99)
  caption: string; // clip title (used as the hook)
  clipUrl: string; // DURABLE export URL (MP4) — empty until the clip is exported
  previewUrl: string; // short-lived signed preview MP4; always present once rendering finishes
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
  /** API-CAP credits consumed this billing month. An allowance, NOT the render balance. */
  used: number | null;
  /** Monthly API-cap allowance. */
  limit: number | null;
  /** limit - used, when both are known. STILL THE API CAP — see balanceMinutes. */
  remaining: number | null;
  /** True when the workspace is exempt from caps — treat as unlimited API-cap headroom. */
  uncapped: boolean;
  /** THE METER THAT ACTUALLY BILLS A RENDER: processing minutes left on the plan.
   *
   *  This is the number a submit is checked against, and it is completely independent of the API
   *  cap above. A live account read 4 minutes here while `remaining` read 88,812 — so a floor on
   *  `remaining` passes cheerfully while every single submit comes back 402. null when the
   *  response does not carry it; callers must treat null as "no signal", never as "no credits". */
  balanceMinutes: number | null;
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
  // credits.remaining_minutes, confirmed against a live response.
  const credits = d.credits ?? {};
  const balanceMinutes = num(credits?.remaining_minutes ?? credits?.remainingMinutes ?? credits?.minutes);
  return {
    used,
    limit,
    remaining: remainingRaw ?? (used != null && limit != null ? limit - used : null),
    uncapped: Boolean(d.uncapped ?? monthly?.uncapped ?? false),
    balanceMinutes,
  };
}

/** Context that sharpens the curation prompt for a specific video. */
export interface CurationContext {
  title?: string;
  speaker?: string;
  channel?: string;
  /** Moment-selection instruction from the active audience profile. Defaults to the
   *  AI/developer brief when absent, which is what callers got before profiles existed. */
  brief?: string;
  /** Content refusals from the active profile, injected as overriding hard rules. */
  guardrails?: string[];
}

/** What we tell ClipAnything to look for — the single highest-leverage prompt in the pipeline.
 *  The scorer only decides which video is worth paying for; THIS decides what people actually see.
 *
 *  The hunting instruction comes from the active audience profile (see ./audience.ts) so it can't
 *  drift out of agreement with the scorer and the editor. Everything below the brief is invariant:
 *  self-containment and the X format hold for every audience. */
export function buildCurationPrompt(ctx: CurationContext = {}): string {
  const who = ctx.speaker ? ` from ${ctx.speaker}` : "";
  const what = ctx.title ? ` of "${ctx.title}"` : "";
  const context = what || who ? `This is a long video${what}${who}.` : "";
  return [
    context,
    (ctx.brief ?? AI_DEVELOPER.curationBrief).trim(),
    ...(ctx.guardrails?.length
      ? [`Hard rules that override every selection consideration above: ${ctx.guardrails.join(" ")}`]
      : []),
    `The clip must be fully self-contained: it starts at the beginning of a thought and ends at its natural conclusion — never cut mid-sentence and never depend on context the viewer hasn't seen.`,
    `Avoid: intros, speaker introductions, thank-yous, audience Q&A logistics, sponsor reads, and generic high-level summaries.`,
    `Format for X: vertical 9:16, with accurate burned-in captions (most viewers watch muted), 30-90 seconds long.`,
  ].filter(Boolean).join(" ");
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

/** Account- or environment-level refusals of a create: nothing about THIS CANDIDATE is wrong,
 *  nothing was billed, and the next candidate in the run will probably hit the same wall.
 *
 *  These must never consume a submit attempt. That is exactly how a billing lapse silently ate the
 *  whole backlog: a 402 counted as a per-candidate retry, three runs pushed every waiting candidate
 *  to `failed`, and the drain only selects rows under MAX_SUBMIT_ATTEMPTS — so they were excluded
 *  permanently for a condition the operator had not been told about (see #51, #54).
 *
 *  - "credit": `402 InsufficientCreditError` — the account is out of render budget. Note this is a
 *    DIFFERENT METER from GET /api/api-usage, which reports the API rate cap: the cap can read tens
 *    of thousands of credits remaining while the plan's render balance is empty, which is why the
 *    pre-flight MIN_CREDITS_REMAINING gate cannot see it coming.
 *  - "proxy": `403 ProxyNotAllowedError` — OpusClip refuses datacenter egress IPs for accounts
 *    without an active subscription. Every Vercel function egresses from a datacenter, so this is a
 *    statement about the ACCOUNT, not about the request. It presents as intermittent because it
 *    depends on which egress IP the instance drew, so retrying is productive — but it must not cost
 *    the candidate its attempts. */
export type AccountBlock = "credit" | "proxy";

export function accountBlockKind(e: unknown): AccountBlock | null {
  const m = (e as Error)?.message ?? String(e);
  if (/\s402:/.test(m) || /InsufficientCredit/i.test(m)) return "credit";
  // The 403 STATUS counts, not only the body text. Detecting this by body string alone meant a
  // 403 with a reworded or non-JSON body was misclassified as a per-candidate failure, consumed a
  // submit attempt, and — three runs in — pushed the whole backlog to `failed`. That regression
  // has already happened once on this repo.
  if (/ProxyNotAllowed/i.test(m) || /\s403:/.test(m)) return "proxy";
  return null;
}

/** Operator-facing explanation of a block, for the event log. */
export function accountBlockNote(kind: AccountBlock): string {
  return kind === "credit"
    ? "the OpusClip account is out of render budget. Note the API cap (/api/admin/diagnostics → "
      + "opusclip) is a DIFFERENT meter and can still read healthy — check the plan's remaining hours."
    : "OpusClip refused the request as VPN/proxy traffic (403 ProxyNotAllowedError). It blocks "
      + "datacenter egress — which is every Vercel function — for accounts without an active "
      + "subscription, so this is about the account, not the video.";
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
  // `project_id` first: the live data model is snake_case throughout (clip_id, duration_sec,
  // preview_url, remaining_minutes). Missing it here is the expensive kind of miss — the project
  // has ALREADY been created and billed by the time this parses, and a throw is classified
  // non-retryable, so the id is lost and the paid project is unreachable forever.
  const id = String(proj?.project_id ?? proj?.id ?? proj?.projectId ?? "");
  if (!id) throw new Error(`OpusClip: no project id in create response: ${JSON.stringify(data).slice(0, 300)}`);
  return id;
}

function asArray(data: any): any[] {
  if (Array.isArray(data)) return data;
  // `data.clips` was missing, which is the envelope every other function in this file assumes
  // (`data.data ?? data`) combined with the key the live response actually uses. Bottoming out at
  // [] here is indistinguishable from "still rendering", so a shape miss reproduces the original
  // three-week outage exactly: no clips, no error, no signal.
  return data?.data?.list
    ?? data?.data?.clips
    ?? (Array.isArray(data?.data) ? data.data : null)
    ?? data?.clips ?? data?.list ?? [];
}

// WHAT IS ACTUALLY CONFIRMED, and what is not.
//
// This block used to claim every field name here was "verified against OpusClip's reference CLI".
// It was not, and the claim is what kept the bug alive: three weeks of review all stopped at a
// comment asserting the answer. Observed from a real project (P3100504VPJi, stage COMPLETE, 17
// clips): the listed clips carry a PREVIEW url and no export field whatsoever. Everything else
// below is a defensive guess, deliberately written as a fallback chain so a wrong guess degrades
// to a usable default instead of silently producing "" or 0.
//
// Start/end are cosmetic: the source range is not exposed and we post the rendered file, not a
// time range, so they are derived from the clip duration.
function normalizeClip(c: any): OpusClipResult {
  const durationS = c.durationMs != null ? Number(c.durationMs) / 1000 : Number(c.duration_sec ?? c.durationSec ?? 0);
  return {
    // `clip_id` is the real field, CONFIRMED against a live response. This read
    // `id ?? clipId ?? curationId`, none of which exist, so clipId was "" for every clip —
    // which nulled clips.opusClipId (breaking cross-posting) and, worse, made the export call
    // below a guaranteed no-op, since exporting needs the clip id. `curationId` is a different
    // id space entirely and never belonged in this chain.
    clipId: String(c.clip_id ?? c.clipId ?? c.id ?? ""),
    startS: 0,
    endS: durationS,
    score: Number(c.score ?? c.judgeResult?.hookScore ?? 0),
    caption: String(c.title ?? c.description ?? ""),
    // THE RENDERED FILE'S URL, under every name OpusClip has used for it.
    //
    // This read `uriForExport ?? export_url` only, and neither is EVER populated by the list
    // endpoint: clips are preview-only until explicitly exported. So clipUrl was "" for every
    // clip, `done` was never true, and collectRenders retried each candidate until it expired and
    // recorded "Render timed out (no clips after 2h)" — against projects holding seventeen
    // finished, scored, portrait clips. No clip row was ever written, which is why nothing reached
    // the review queue, let alone X. That is the whole three-week outage, in one `??` chain.
    //
    // An export field here is still honoured in case a plan populates it, but the real export is
    // opusclipExportClip() below, called once for the clip the editor actually picks.
    clipUrl: String(c.uriForExport ?? c.export_url ?? c.exportUrl ?? ""),
    // The preview is a real, playable, correctly-cropped MP4 — good enough to judge and to post,
    // but its signed URL is SHORT-LIVED. It is kept separate from clipUrl so the difference is
    // visible at the call site rather than hidden inside a fallback chain: anything persisted and
    // replayed later (the public /clips pages read clips.clipUrl) wants the export, not this.
    previewUrl: String(c.previewUrl ?? c.preview_url ?? c.videoUrl ?? c.video_url ?? ""),
    costUsd: 0,
    // Both spellings: the vendor's own tooling documents a flat `render_pending`, while the shape
    // this client was written against nested it under renderAsVideoFile. Unconfirmed either way,
    // so accept both and default to "not pending" — the URL check is the real readiness gate.
    renderPending: Boolean(c.render_pending ?? c.renderPending ?? c.renderAsVideoFile?.pending ?? false),
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
  // READY means "OpusClip has finished rendering this clip", which is a preview being available —
  // NOT an export URL being present. Gating on clipUrl was the outage: an export never appears
  // here no matter how long you wait, so `done` was permanently false. The export is a separate,
  // explicit step taken once, for the one clip the editor picks (opusclipExportClip below).
  const done = clips.some((c) => (c.clipUrl || c.previewUrl) && !c.renderPending);
  return { clips, done };
}

// ── Export: turning a preview into a durable file ───────────────────────────

export type OpusExportStatus = "ready" | "rendering" | "unavailable";

export interface OpusExportResult {
  status: OpusExportStatus;
  /** The durable MP4 URL. Only meaningful when status === "ready". */
  url: string;
  /** Human-readable note for the log when this is not "ready". */
  detail: string;
}

/** REST spellings tried for the export action, in order, until one answers.
 *
 *  NOT CONFIRMED — and said plainly rather than asserted, because an unverified "verified" comment
 *  in this file is what hid the original bug for three weeks. What IS confirmed is the behaviour,
 *  from the vendor's own tooling: export is per-clip and explicit, it starts the render on demand
 *  when no artifact exists yet, calling it again never starts a second render (so it is safe to
 *  retry and safe to poll), and it answers ready | rendering | unavailable.
 *
 *  The first spelling that does not 404/405 is remembered for the life of the process. If none
 *  answer, callers fall back to the preview URL and log loudly — a wrong guess here costs clip
 *  durability, never the post itself. Confirm the real path with /api/debug/opusclip?projectId=…
 *  and then delete this list in favour of the single endpoint. */
const EXPORT_PATH_CANDIDATES = [
  (p: string, c: string) => ({ path: `/api/exportable-clips/${encodeURIComponent(c)}/export`, body: { projectId: p, target: "hd" } }),
  (p: string, c: string) => ({ path: `/api/clip-exports`, body: { projectId: p, clipId: c, target: "hd" } }),
  (p: string, c: string) => ({ path: `/api/exportable-clips?q=export`, body: { projectId: p, clipId: c, target: "hd" } }),
];

/** Index into EXPORT_PATH_CANDIDATES that last worked, cached per process. -1 = not yet known. */
let exportPathHint = -1;

function readExport(data: any): OpusExportResult {
  const raw = String(data?.status ?? data?.data?.status ?? "").toLowerCase();
  const url = String(
    data?.export_url ?? data?.exportUrl ?? data?.url ?? data?.uriForExport
    ?? data?.data?.export_url ?? data?.data?.exportUrl ?? data?.data?.url ?? "",
  );
  if (url && (raw === "ready" || raw === "")) return { status: "ready", url, detail: "" };
  if (raw === "rendering" || raw === "pending" || raw === "processing") {
    return { status: "rendering", url: "", detail: "export still rendering" };
  }
  if (raw === "unavailable" || raw === "failed") {
    return { status: "unavailable", url: "", detail: `OpusClip reports the export is ${raw}` };
  }
  // Answered, but in a shape this client does not recognise. Treat as unavailable rather than
  // looping: a shape mismatch does not resolve itself by waiting, and the caller logs the body.
  return {
    status: "unavailable",
    url: "",
    detail: `unrecognised export response: ${JSON.stringify(data).slice(0, 300)}`,
  };
}

/** Ask OpusClip for the durable HD file for ONE clip, starting the export if it has not run.
 *
 *  Called once per clip that is actually going to be posted — never for every clip in a project.
 *  Idempotent by the vendor's contract ("calling again never starts a second render"), so a retry
 *  or a poll cannot double-charge. */
export async function opusclipExportClip(
  projectId: string,
  clipId: string,
  apiKey: string,
  base: string,
): Promise<OpusExportResult> {
  if (!projectId || !clipId) {
    return { status: "unavailable", url: "", detail: "missing project or clip id" };
  }

  const order = exportPathHint >= 0
    ? [exportPathHint, ...EXPORT_PATH_CANDIDATES.keys()].filter((v, i, a) => a.indexOf(v) === i)
    : [...EXPORT_PATH_CANDIDATES.keys()];

  let lastErr = "";
  for (const i of order) {
    const { path, body } = EXPORT_PATH_CANDIDATES[i](projectId, clipId);
    try {
      // retry: true is safe here and nowhere else in this client — this POST is idempotent by
      // contract, unlike project creation which bills on every call.
      const data = await opusFetch("POST", path, apiKey, base, body, { retry: true });
      const parsed = readExport(data);
      // PIN ONLY ON SUCCESS. This pinned on "did not 404", so a wrong endpoint answering 200 with
      // an unrecognised body would be cached for the life of the process and make every later
      // export permanently "unavailable" — the whole fleet falling back to preview URLs forever
      // because of one bad guess on the first call.
      if (parsed.status !== "unavailable") exportPathHint = i;
      return parsed;
    } catch (e) {
      const msg = (e as Error).message;
      lastErr = msg;
      // Only a "wrong endpoint" answer justifies trying the next spelling. Anything else (401,
      // 402, 403, 5xx) is a real answer from the right endpoint and must not be papered over by
      // walking the list.
      //
      // Matched against the STATUS, not the whole error string. opusFetch formats failures as
      // `OpusClip POST <path> <status>: <body>`, and testing the lot meant a 200-with-"404"-in-
      // the-body, or any body quoting those digits, resumed walking and POSTed to a different
      // endpoint — exactly what the paragraph above says must not happen.
      const status = /OpusClip \w+ [^ ]+ (\d{3}):/.exec(msg)?.[1];
      if (status !== "404" && status !== "405") break;
    }
  }
  return {
    status: "unavailable",
    url: "",
    detail: lastErr || "no export endpoint answered",
  };
}
