import { NextRequest, NextResponse } from "next/server";
import { runScout } from "@/lib/pipeline/runScout";
import { runSummon } from "@/lib/pipeline/summon";
import { runFeedback } from "@/lib/pipeline/feedback";

export const dynamic = "force-dynamic";
// Hobby caps functions at 60s; on Vercel Pro raise to 300 — OpusClip render polling needs it.
export const maxDuration = 60;

// Backstop route that runs the whole cycle (scout → summon → feedback) in one call. Not wired
// into vercel.json anymore — the split scout/summon/feedback crons run on their own cadence — but
// kept so the full cycle can still be invoked manually in one request.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  try {
    const scout = await runScout();
    const summon = await runSummon();
    const feedback = await runFeedback();
    return NextResponse.json({ ok: true, scout, summon, feedback });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
