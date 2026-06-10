import { NextRequest, NextResponse } from "next/server";
import { runSummon } from "@/lib/pipeline/summon";

export const dynamic = "force-dynamic";
// Hobby caps functions at 60s; on Vercel Pro raise to 300 — OpusClip render polling needs it.
export const maxDuration = 60;

// Vercel Cron polls this for new @videoclipthis mentions (Authorization: Bearer $CRON_SECRET).
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  try {
    const result = await runSummon();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
