import { NextRequest, NextResponse } from "next/server";
import { cronAuthError } from "@/lib/pipeline/cron-auth";
import { hasXbotWriteEnv } from "@/lib/xbot/env";
import { checkOutbound } from "@/lib/xbot/outbound";
import { getXbotSettings } from "@/lib/xbot/settings";

export const dynamic = "force-dynamic";
// One Claude call per target with a fresh post; allow a batch to finish.
export const maxDuration = 300;

/** Vercel Cron: the outbound "reply guy" loop. Reads target-roster timelines and drafts
 *  useful replies to their fresh original posts into the review queue — posting still goes
 *  through approval (or auto, per settings). Skips cleanly while paused or before creds. */
export async function GET(req: NextRequest) {
  const denied = cronAuthError(req);
  if (denied) return denied;
  try {
    if (!hasXbotWriteEnv()) {
      return NextResponse.json({ ok: true, skipped: "XBOT_* credentials not configured" });
    }
    if ((await getXbotSettings()).paused) {
      return NextResponse.json({ ok: true, skipped: "xbot is paused" });
    }
    const result = await checkOutbound();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
