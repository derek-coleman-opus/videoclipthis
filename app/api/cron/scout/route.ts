import { NextRequest, NextResponse } from "next/server";
import { runScout } from "@/lib/pipeline/runScout";

export const dynamic = "force-dynamic";
// Clipping (OpusClip analyze + render) can take minutes — needs more than the 60s default.
export const maxDuration = 300;

// Vercel Cron calls this on a schedule (see vercel.json) with Authorization: Bearer $CRON_SECRET.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  try {
    const result = await runScout();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
