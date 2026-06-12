import { NextResponse } from "next/server";
import { requireXbotDraftEnv, requireXbotEnv } from "@/lib/xbot/env";
import { checkInbound } from "@/lib/xbot/inbound";

export const dynamic = "force-dynamic";
// One Claude call per new engager; allow a batch to finish.
export const maxDuration = 300;

/** Reply-to-everyone loop: fetch new mentions and queue engage-back drafts for review.
 *  Needs the personal-account write tokens (mentions are read in user context). */
export async function POST() {
  try {
    requireXbotDraftEnv();
    requireXbotEnv();
    const result = await checkInbound();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
