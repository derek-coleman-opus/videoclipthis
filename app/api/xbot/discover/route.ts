import { NextResponse } from "next/server";
import { requireXbotDraftEnv, requireXbotEnv } from "@/lib/xbot/env";
import { runDiscovery } from "@/lib/xbot/discovery";

export const dynamic = "force-dynamic";
// One Claude call per evaluated account; allow a batch to finish.
export const maxDuration = 300;

/** Autonomous roster discovery: search niche keywords and auto-add good niche creators as
 *  candidate targets. Searches in user context, so it needs the personal-account write tokens. */
export async function POST() {
  try {
    requireXbotDraftEnv();
    requireXbotEnv();
    const result = await runDiscovery();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
