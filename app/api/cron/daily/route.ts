import { NextRequest, NextResponse } from "next/server";
import { runScout } from "@/lib/pipeline/runScout";
import { runSummon } from "@/lib/pipeline/summon";
import { runFeedback } from "@/lib/pipeline/feedback";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Hobby-friendly: ONE daily cron that runs the whole cycle (scout → summon → feedback).
// On Pro you can split these back into separate, more frequent crons (see /api/cron/{scout,summon,feedback}).
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
