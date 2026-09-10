import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, candidates } from "@/lib/db";
import { logEvent } from "@/lib/pipeline/events";

export const dynamic = "force-dynamic";

/** Force a candidate the scorer rejected through the render + post pipeline.
 *
 *  Sets `forced`, which two gates check: the backlog drain ignores the score threshold for it
 *  (runScout.ts) and the editorial veto is skipped (render.ts) — the same exemption summon clips
 *  already had, on the same reasoning. The operator picked this specific video; "it scored 38" is
 *  not a useful answer to that.
 *
 *  SPENDS MONEY: this becomes a paid OpusClip render on the next Scout run. Admin basic-auth via
 *  middleware. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  if (!id) return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });

  const database = db();
  const row = (await database.select().from(candidates).where(eq(candidates.id, id)).limit(1))[0];
  if (!row) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });

  // Already rendered or posted: forcing again would pay for the same video twice. `opusProjectId`
  // is the billing proof — if OpusClip made a project for this row, it was charged.
  if (row.opusProjectId) {
    return NextResponse.json(
      { ok: false, error: `already submitted to OpusClip (project ${row.opusProjectId}) — forcing again would pay twice` },
      { status: 409 },
    );
  }
  if (["rendering", "selected", "posted"].includes(row.status)) {
    return NextResponse.json({ ok: false, error: `candidate is ${row.status}` }, { status: 409 });
  }

  await database
    .update(candidates)
    // submit_attempts resets too: a candidate that failed earlier for an account-level reason
    // would otherwise be forced and then immediately skipped by the drain's attempt cap.
    .set({ status: "scored", forced: true, submitAttempts: 0 })
    .where(eq(candidates.id, id));
  await logEvent(
    "scored",
    `FORCED by operator [score ${row.score ?? "?"}]: ${row.title} — will render on the next Scout `
    + `run, bypassing the score gate and the editorial veto. This is a paid render.`,
    "candidates",
    id,
  );
  return NextResponse.json({
    ok: true,
    status: "scored",
    next: "Hit “Run Scout now” to submit it without waiting for the next cron.",
  });
}
