import { NextRequest, NextResponse } from "next/server";
import { hasXbotWriteEnv } from "@/lib/xbot/env";
import { checkInbound } from "@/lib/xbot/inbound";
import { getXbotSettings } from "@/lib/xbot/settings";

export const dynamic = "force-dynamic";
// One Claude call per new engager; allow a batch to finish.
export const maxDuration = 300;

/** Vercel Cron: the reply-to-everyone loop. Drafts engage-backs into the review queue —
 *  posting still goes through approval (or auto, per settings), so this runs even during
 *  quiet hours. Skips cleanly while paused or before the X credentials exist. */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  try {
    if (!hasXbotWriteEnv()) {
      return NextResponse.json({ ok: true, skipped: "XBOT_* credentials not configured" });
    }
    if ((await getXbotSettings()).paused) {
      return NextResponse.json({ ok: true, skipped: "xbot is paused" });
    }
    const result = await checkInbound();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
