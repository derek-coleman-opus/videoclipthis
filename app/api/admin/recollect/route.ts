import { NextResponse } from "next/server";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, candidates } from "@/lib/db";
import { logEvent } from "@/lib/pipeline/events";
import { withSchemaHeal } from "@/lib/db/ensureSchema";

export const dynamic = "force-dynamic";

/** Candidates whose render WAS PAID FOR but was never collected.
 *
 *  This is the exact complement of /api/admin/requeue, and the distinction is the whole point:
 *
 *    requeue   → `failed` AND opus_project_id IS NULL     → nothing was billed → RE-SUBMIT (pays)
 *    recollect → `failed` AND opus_project_id IS NOT NULL → already billed    → RE-POLL (free)
 *
 *  Requeue's `IS NULL` guard is correct and stays: re-submitting a billed row would pay twice. But
 *  it left the billed rows reachable by nothing at all — requeue excluded them, /api/admin/force
 *  409s on them (it reads the same project id as billing proof), and no automatic query selects
 *  `failed`. Their renders sat finished and complete on OpusClip's side, fully paid, unreachable.
 *
 *  Re-polling an existing project creates no new project and costs nothing, so unlike requeue this
 *  is safe to run freely. It is still a POST behind admin basic-auth because it moves pipeline
 *  state. */
const RECOLLECTABLE = and(
  eq(candidates.status, "failed"),
  isNotNull(candidates.opusProjectId),
);

/** How many paid-but-uncollected renders are waiting. Read-only, so the admin can show a count. */
export async function GET() {
  // Heal the schema on a missing column: this route reads candidates directly, so a newly added
  // column would 500 it until the migration was applied by hand.
  return withSchemaHeal(async () => {
    try {
      const rows = await db()
        .select({ n: sql<number>`count(*)::int` })
        .from(candidates)
        .where(RECOLLECTABLE);
      return NextResponse.json({ ok: true, recollectable: Number(rows[0]?.n ?? 0) });
    } catch (e) {
      return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
    }
  });
}

/** Put paid-but-uncollected renders back in front of the collector.
 *
 *  COSTS NOTHING: no project is created — collectRenders() simply polls the project that was
 *  already paid for and builds a clip from whatever it finds. */
export async function POST() {
  return withSchemaHeal(async () => {
    try {
      const revived = await db()
        .update(candidates)
        .set({
          status: "rendering",
          // The timeout clock in collectRenders() runs from render_started_at, so leaving the
          // original submit time in place would have the collector expire every one of these rows
          // again on the very first pass — straight back to `failed`, having achieved nothing.
          // Resetting it grants a fresh RENDER_TIMEOUT_H window to collect an already-finished
          // render; it does not grant a new render.
          renderStartedAt: new Date(),
        })
        .where(RECOLLECTABLE)
        .returning({ id: candidates.id });

      if (revived.length) {
        await logEvent(
          "run",
          `Re-collecting ${revived.length} paid render(s) that were never harvested — the OpusClip `
          + `projects already exist, so this creates no new charge. They will be picked up by the `
          + `next collect cycle.`,
        );
      }
      return NextResponse.json({
        ok: true,
        recollected: revived.length,
        next: revived.length
          ? "Hit “Run Scout now” to collect them without waiting for the next cron."
          : "Nothing to re-collect — no paid render is sitting uncollected.",
      });
    } catch (e) {
      return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
    }
  });
}
