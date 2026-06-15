import { NextRequest, NextResponse } from "next/server";
import { buildCreateProjectBody } from "@/lib/pipeline/opusclip";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// In-app OpusClip probe (admin basic-auth via middleware). Shows the RAW API contract so
// integration failures are diagnosed from real response bodies, in the cloud, from a browser:
//
//   GET /api/debug/opusclip?video=<youtube-url>   → key check + create project + first clip checks
//   GET /api/debug/opusclip?projectId=<id>        → raw exportable-clips response for a project
//
// Every step's raw body is returned in the JSON response.

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

  // Mode 2: just check an existing project's clips, raw.
  if (projectId) {
    const clips = await call("GET", `/api/exportable-clips?q=findByProjectId&projectId=${encodeURIComponent(projectId)}`);
    steps.push({ step: `GET /api/exportable-clips (projectId=${projectId})`, ...clips });
    return NextResponse.json({ projectId, steps }, { status: 200 });
  }

  if (!video) {
    return NextResponse.json({
      usage: "GET ?video=<youtube-url> to run a full probe, or ?projectId=<id> to check an existing project",
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
