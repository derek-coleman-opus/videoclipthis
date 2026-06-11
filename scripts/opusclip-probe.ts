/**
 * OpusClip API probe — run this to see the RAW request/response contract in one shot.
 * No database, no pipeline; just the API. Usage:
 *
 *   OPUSCLIP_API_KEY=sk_... npm run probe -- "https://www.youtube.com/watch?v=VIDEO_ID"
 *
 * Steps (raw JSON printed at every stage):
 *   1. GET  /api/api-usage?q=mine      — proves the key works + shows quota
 *   2. POST /api/clip-projects         — our exact production payload
 *   3. GET  /api/exportable-clips      — polled every 20s for up to 20 min, raw body printed
 *
 * Paste the full output back into the Claude session to get the client fixed from real data.
 */
import { buildCurationPrompt } from "@/lib/pipeline/opusclip";

const BASE = (process.env.OPUSCLIP_API_BASE ?? "https://api.opus.pro").replace(/\/$/, "");
const KEY = process.env.OPUSCLIP_API_KEY ?? "";
const VIDEO = process.argv[2] ?? "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

const POLL_EVERY_MS = 20_000;
const POLL_FOR_MS = 20 * 60_000;

function show(label: string, status: number, body: string) {
  console.log(`\n===== ${label} → HTTP ${status} =====`);
  try {
    console.log(JSON.stringify(JSON.parse(body), null, 2));
  } catch {
    console.log(body.slice(0, 2000));
  }
}

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function main() {
  if (!KEY) {
    console.error("Set OPUSCLIP_API_KEY (in .env or inline). Nothing else is needed.");
    process.exit(2);
  }
  console.log(`base: ${BASE}\nvideo: ${VIDEO}`);

  // 1. Key + quota sanity check.
  const usage = await call("GET", "/api/api-usage?q=mine");
  show("GET /api/api-usage?q=mine", usage.status, usage.text);
  if (usage.status === 401 || usage.status === 403) {
    console.error("\n⛔ The API key was rejected before we even tried to clip. Fix the key/plan first.");
    process.exit(1);
  }

  // 2. Create a project with our EXACT production payload.
  const payload = {
    videoUrl: VIDEO,
    curationPref: {
      model: "ClipAnything",
      clipDurations: [30, 60, 90],
      customPrompt: buildCurationPrompt({ title: "probe run" }),
    },
    renderPref: {
      layoutAspectRatio: "9:16",
      quickstartConfig: { enableRemoveFillerWords: true },
    },
  };
  console.log(`\n===== POST /api/clip-projects payload =====\n${JSON.stringify(payload, null, 2)}`);
  const created = await call("POST", "/api/clip-projects", payload);
  show("POST /api/clip-projects", created.status, created.text);
  if (created.status >= 400) {
    console.error("\n⛔ Project creation rejected — the error body above is the fix.");
    process.exit(1);
  }

  let parsed: any = {};
  try { parsed = JSON.parse(created.text); } catch { /* shown above */ }
  const proj = parsed.data ?? parsed.project ?? parsed;
  const projectId = String(proj?.id ?? proj?.projectId ?? "");
  console.log(`\nextracted projectId: ${projectId || "⛔ NONE — our id parsing is wrong, see raw body above"}`);
  if (!projectId) process.exit(1);

  // 3. Poll exportable-clips, printing the raw body every time so shape changes are visible.
  const deadline = Date.now() + POLL_FOR_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const clips = await call("GET", `/api/exportable-clips?q=findByProjectId&projectId=${encodeURIComponent(projectId)}`);
    show(`GET /api/exportable-clips (attempt ${attempt})`, clips.status, clips.text);
    try {
      const data = JSON.parse(clips.text);
      const list = Array.isArray(data) ? data : data?.data?.list ?? data?.data ?? data?.clips ?? data?.list ?? [];
      if (Array.isArray(list) && list.length > 0) {
        console.log(`\n✅ ${list.length} clip(s) present — raw objects above show the real field names. Done.`);
        return;
      }
    } catch { /* raw body already printed */ }
    await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
  }
  console.error(`\n⛔ No clips after ${POLL_FOR_MS / 60000} min — check this project in the OpusClip dashboard (clip.opus.pro), id: ${projectId}`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
