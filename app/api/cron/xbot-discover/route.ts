import { NextRequest, NextResponse } from "next/server";
import { hasXbotWriteEnv } from "@/lib/xbot/env";
import { runDiscovery } from "@/lib/xbot/discovery";
import { getXbotSettings } from "@/lib/xbot/settings";

export const dynamic = "force-dynamic";
// One Claude call per evaluated account; allow a batch to finish.
export const maxDuration = 300;

/** Vercel Cron: autonomous roster discovery. Searches niche keywords and auto-adds good
 *  niche creators as candidate targets (which the outbound loop then engages, under review).
 *  Skips cleanly while paused, before creds, or when the roster is already full. */
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
    const result = await runDiscovery();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
