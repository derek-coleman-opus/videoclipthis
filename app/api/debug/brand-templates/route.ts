import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// List your OpusClip brand templates so you can copy a brandTemplateId into
// Settings → OpusClip brand template (admin basic-auth via middleware).
//   GET /api/debug/brand-templates
// Configure the template's vertical layout + caption style in the OpusClip dashboard, then paste
// its id in Settings — that's what makes slide-heavy talks fit 9:16 instead of cropping.
export async function GET() {
  const key = process.env.OPUSCLIP_API_KEY;
  if (!key) return NextResponse.json({ error: "OPUSCLIP_API_KEY is not set" }, { status: 500 });
  const base = (process.env.OPUSCLIP_API_BASE ?? "https://api.opus.pro").replace(/\/$/, "");

  try {
    const res = await fetch(`${base}/api/brand-templates?q=mine`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    });
    const text = await res.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 2000); }
    return NextResponse.json({
      status: res.status,
      hint: "Copy a template's id (brandTemplateId) into Settings → OpusClip brand template.",
      body,
    }, { status: 200 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
