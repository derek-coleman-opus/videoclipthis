import { NextRequest, NextResponse } from "next/server";
import { cronAuthError } from "@/lib/pipeline/cron-auth";
import { runScout } from "@/lib/pipeline/runScout";
import { runSummon } from "@/lib/pipeline/summon";
import { runFeedback } from "@/lib/pipeline/feedback";

export const dynamic = "force-dynamic";
// Pro budget: OpusClip render polling can take several minutes.
export const maxDuration = 300;

// Backstop route that runs the whole cycle (scout → summon → feedback) in one call. Not wired
// into vercel.json anymore — the split scout/summon/feedback crons run on their own cadence — but
// kept so the full cycle can still be invoked manually in one request.
export async function GET(req: NextRequest) {
  const denied = cronAuthError(req);
  if (denied) return denied;
  try {
    const scout = await runScout();
    const summon = await runSummon();
    const feedback = await runFeedback();
    return NextResponse.json({ ok: true, scout, summon, feedback });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
