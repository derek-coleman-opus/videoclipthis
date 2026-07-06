import { NextResponse } from "next/server";
import { requireXbotDraftEnv, requireXbotEnv } from "@/lib/xbot/env";
import { runPostingDue } from "@/lib/xbot/postingWorker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Manual "Post due now": run the autonomy engine on demand (posts auto-eligible drafts under
 *  the safety gate + pacing, then auto-likes). Needs the personal-account write tokens. */
export async function POST() {
  try {
    requireXbotDraftEnv();
    requireXbotEnv();
    const result = await runPostingDue();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
