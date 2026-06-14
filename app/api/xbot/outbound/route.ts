import { NextResponse } from "next/server";
import { requireXbotDraftEnv, requireXbotEnv } from "@/lib/xbot/env";
import { checkOutbound } from "@/lib/xbot/outbound";

export const dynamic = "force-dynamic";
// One Claude call per target with a fresh post; allow a batch to finish.
export const maxDuration = 300;

/** Outbound roster loop: read target timelines and queue useful replies to their fresh
 *  original posts (no @-tag to us required). Reads timelines in user context, so it needs
 *  the personal-account write tokens. */
export async function POST() {
  try {
    requireXbotDraftEnv();
    requireXbotEnv();
    const result = await checkOutbound();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
