import { NextRequest, NextResponse } from "next/server";
import { cronAuthError } from "@/lib/pipeline/cron-auth";
import { runSummon } from "@/lib/pipeline/summon";

export const dynamic = "force-dynamic";
// Pro budget: OpusClip render polling can take several minutes.
export const maxDuration = 300;

// Vercel Cron polls this for new @videoclipthis mentions (Authorization: Bearer $CRON_SECRET).
export async function GET(req: NextRequest) {
  const denied = cronAuthError(req);
  if (denied) return denied;
  try {
    const result = await runSummon();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
