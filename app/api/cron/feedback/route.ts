import { NextRequest, NextResponse } from "next/server";
import { runFeedback } from "@/lib/pipeline/feedback";

export const dynamic = "force-dynamic";
// Pro budget: metrics + reshare lookups across many posted clips can exceed 60s.
export const maxDuration = 300;

// Vercel Cron refreshes clip metrics + reshare signals (Authorization: Bearer $CRON_SECRET).
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  try {
    const result = await runFeedback();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
