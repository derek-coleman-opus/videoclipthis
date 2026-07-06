import { NextRequest, NextResponse } from "next/server";
import { cronAuthError } from "@/lib/pipeline/cron-auth";
import { runPostingDue } from "@/lib/xbot/postingWorker";

export const dynamic = "force-dynamic";
// A safety-gate Claude call per auto-post; allow the batch to finish.
export const maxDuration = 300;

/** Vercel Cron: the autonomy engine. Posts due auto-drafts (safety-gated, paced) and runs
 *  auto-likes. runPostingDue() self-gates on paused / no-credentials / quiet-hours, so this is
 *  safe to fire on a schedule. */
export async function GET(req: NextRequest) {
  const denied = cronAuthError(req);
  if (denied) return denied;
  try {
    const result = await runPostingDue();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
