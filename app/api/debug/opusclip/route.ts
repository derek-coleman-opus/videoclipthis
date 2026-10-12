import { NextRequest, NextResponse } from "next/server";
import { buildCreateProjectBody } from "@/lib/pipeline/opusclip";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// In-app OpusClip probe (admin basic-auth via middleware). Shows the RAW API contract so
// integration failures are diagnosed from real response bodies, in the cloud, from a browser:
//
//   GET /api/debug/opusclip?video=<youtube-url>            → key check + create project + clip checks
//   GET /api/debug/opusclip?projectId=<id>                 → raw exportable-clips response
//   GET /api/debug/opusclip?projectId=<id>&exportClip=<id> → find the real EXPORT endpoint
//
// Every step's raw body is returned in the JSON response.
//
// ?video= CREATES A REAL, BILLED PROJECT. The other two modes do not: they read an existing
// project, and the export probe acts on a clip whose render is already paid for.

const BASE = () => (process.env.OPUSCLIP_API_BASE ?? "https://api.opus.pro").replace(/\/$/, "");

interface Step {
  step: string;
  status: number;
  body: unknown;
}

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE()}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.OPUSCLIP_API_KEY ?? ""}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 3000); }
  return { status: res.status, body: parsed };
}

export async function GET(req: NextRequest) {
  if (!process.env.OPUSCLIP_API_KEY) {
    return NextResponse.json({ error: "OPUSCLIP_API_KEY is not set in this deployment" }, { status: 500 });
  }
  const video = req.nextUrl.searchParams.get("video");
  const projectId = req.nextUrl.searchParams.get("projectId");
  const steps: Step[] = [];

  // Mode 3: find the export endpoint empirically.
  //
  // Clips are preview-only until exported, and the REST spelling of that export is the one part of
  // this integration not confirmed against a real response — so confirm it here rather than guess
  // in the pipeline. Tries each candidate and reports the status and raw body of all of them; the
  // one that is not 404/405 is the real endpoint. Costs nothing: the clip is already rendered and
  // the vendor's contract is that a repeat export never starts a second render.
  const exportClip = req.nextUrl.searchParams.get("exportClip");
  if (projectId && exportClip) {
    const candidates: Array<{ method: "POST" | "GET"; path: string; body?: unknown }> = [
      { method: "POST", path: `/api/exportable-clips/${encodeURIComponent(exportClip)}/export`, body: { projectId, target: "hd" } },
      { method: "POST", path: `/api/clip-exports`, body: { projectId, clipId: exportClip, target: "hd" } },
      { method: "POST", path: `/api/exportable-clips?q=export`, body: { projectId, clipId: exportClip, target: "hd" } },
      { method: "GET", path: `/api/exportable-clips?q=findById&clipId=${encodeURIComponent(exportClip)}` },
    ];
    for (const c of candidates) {
      const res = await call(c.method, c.path, c.body);
      steps.push({ step: `${c.method} ${c.path}`, ...res });
    }
    const hit = steps.find((st) => st.status !== 404 && st.status !== 405);
    return NextResponse.json({
      projectId,
      clipId: exportClip,
      verdict: hit
        ? `${hit.step} answered ${hit.status} — this is the export endpoint. Set it in lib/pipeline/opusclip.ts.`
        : "None of the candidates answered. Ask OpusClip for the export endpoint and add it here.",
      steps,
    }, { status: 200 });
  }

  // Mode 2: just check an existing project's clips, raw.
  if (projectId) {
    const clips = await call("GET", `/api/exportable-clips?q=findByProjectId&projectId=${encodeURIComponent(projectId)}`);
    steps.push({ step: `GET /api/exportable-clips (projectId=${projectId})`, ...clips });
    return NextResponse.json({ projectId, steps }, { status: 200 });
  }

  if (!video) {
    return NextResponse.json({
      usage: "GET ?video=<youtube-url> to run a full probe (CREATES A BILLED PROJECT), "
        + "?projectId=<id> to read an existing project's clips, or "
        + "?projectId=<id>&exportClip=<clipId> to find the export endpoint (free)",
    }, { status: 400 });
  }

  // 1. Key + quota sanity check.
  const usage = await call("GET", "/api/api-usage?q=mine");
  steps.push({ step: "GET /api/api-usage?q=mine", ...usage });
  if (usage.status === 401 || usage.status === 403) {
    return NextResponse.json({ verdict: "API key rejected — fix key/plan first", steps }, { status: 200 });
  }

  // 2. Create a project with the EXACT production payload.
  const payload = buildCreateProjectBody(video, { title: "probe run" });
  steps.push({ step: "POST /api/clip-projects payload", status: 0, body: payload });
  const created = await call("POST", "/api/clip-projects", payload);
  steps.push({ step: "POST /api/clip-projects response", ...created });
  if (created.status >= 400) {
    return NextResponse.json({ verdict: "Project creation rejected — the response body above is the fix", steps }, { status: 200 });
  }

  const parsed: any = created.body;
  const proj = parsed?.data ?? parsed?.project ?? parsed;
  const extractedId = String(proj?.id ?? proj?.projectId ?? "");
  steps.push({ step: "extracted projectId", status: 0, body: extractedId || "NONE — id parsing is wrong, see raw create response" });
  if (!extractedId) return NextResponse.json({ verdict: "Could not extract a project id", steps }, { status: 200 });

  // 3. A few quick clip checks (renders take minutes — re-check later with ?projectId=).
  for (let i = 1; i <= 3; i++) {
    await new Promise((r) => setTimeout(r, 15000));
    const clips = await call("GET", `/api/exportable-clips?q=findByProjectId&projectId=${encodeURIComponent(extractedId)}`);
    steps.push({ step: `GET /api/exportable-clips (check ${i})`, ...clips });
  }

  return NextResponse.json({
    verdict: `Project ${extractedId} created. If no clips above yet, re-check later: /api/debug/opusclip?projectId=${extractedId}`,
    projectId: extractedId,
    steps,
  }, { status: 200 });
}
