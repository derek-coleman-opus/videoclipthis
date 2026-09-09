import { NextResponse } from "next/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, candidates } from "@/lib/db";
import { logEvent } from "@/lib/pipeline/events";

export const dynamic = "force-dynamic";

/** Candidates a requeue would revive: render submit failed, and NOTHING WAS BILLED.
 *
 *  `opus_project_id IS NULL` is the safety condition and the reason this is safe to expose as a
 *  button. A row with a project id was billed by OpusClip; re-submitting it would pay twice. A row
 *  without one provably never created a project, so re-submitting is a first charge, not a second.
 *
 *  Why these rows are stranded: a 402 (account out of render budget) used to count against
 *  `submit_attempts`, so three runs during a billing lapse pushed every waiting candidate to
 *  `failed` — and the backlog drain only selects rows under MAX_SUBMIT_ATTEMPTS, which excluded
 *  them permanently. #51 stopped new ones being created; it could not recover the existing ones. */
const REQUEUABLE = and(eq(candidates.status, "failed"), isNull(candidates.opusProjectId));

/** How many candidates are stranded — read-only, so the admin can show a count before acting. */
export async function GET() {
  try {
    const rows = await db()
      .select({ n: sql<number>`count(*)::int` })
      .from(candidates)
      .where(REQUEUABLE);
    return NextResponse.json({ ok: true, requeueable: Number(rows[0]?.n ?? 0) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

/** Put stranded candidates back in the render queue.
 *
 *  SPENDS MONEY: each requeued candidate becomes a paid OpusClip render on the next scout run
 *  (roughly 1 credit per minute of source video). That is why it is a deliberate POST behind a
 *  confirmation rather than part of any automatic heal. Admin basic-auth via middleware. */
export async function POST() {
  try {
    const requeued = await db()
      .update(candidates)
      .set({ status: "scored", submitAttempts: 0 })
      .where(REQUEUABLE)
      .returning({ id: candidates.id });

    if (requeued.length) {
      await logEvent(
        "run",
        `Requeued ${requeued.length} stranded candidate(s) for render — they will submit on the `
        + `next Scout run and each one is a paid render.`,
      );
    }
    return NextResponse.json({
      ok: true,
      requeued: requeued.length,
      next: requeued.length
        ? "Hit “Run Scout now” to submit them without waiting for the next cron."
        : "Nothing was stranded — the queue is empty for another reason.",
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
