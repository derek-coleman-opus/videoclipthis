import { NextRequest, NextResponse } from "next/server";
import { and, eq, gte } from "drizzle-orm";
import { db, candidates } from "@/lib/db";
import { extractPersonName, resolveXHandle } from "@/lib/pipeline/handleResolver";
import { logEvent } from "@/lib/pipeline/events";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Rescue "held" candidates (they passed the score gate but pre-date automatic handle
 *  resolution): extract the speaker from the title, resolve + verify handles, and requeue
 *  them as "scored" — the next scout cycle submits their renders under the normal slot and
 *  cost caps. Idempotent: released rows leave the held pool. ?days=N bounds recency (default
 *  7 — older moments have gone stale and shouldn't be posted late). */
export async function GET(req: NextRequest) {
  const days = Math.max(1, Math.min(30, Number(req.nextUrl.searchParams.get("days") ?? 7) || 7));
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const database = db();

  // Bounded batch per call — each row can cost a few Claude/X lookups (cached thereafter).
  const rows = await database
    .select().from(candidates)
    .where(and(eq(candidates.status, "held"), gte(candidates.createdAt, cutoff)))
    .limit(25);

  const results: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const ctx = `speaker/channel of "${row.title}"${row.channel ? ` (YouTube channel: ${row.channel})` : ""}`;
    const speaker = row.speaker || (await extractPersonName(row.title, row.channel ?? "")) || "";
    let speakerHandle = row.speakerHandle || "";
    let channelXHandle = row.channelXHandle || "";
    if (!speakerHandle && speaker) {
      speakerHandle = (await resolveXHandle("person", speaker, ctx)) ?? "";
    }
    if (!channelXHandle && row.channel) {
      channelXHandle = (await resolveXHandle("brand", row.channel, ctx)) ?? "";
    }
    await database.update(candidates)
      .set({ speaker, speakerHandle, channelXHandle, status: "scored" })
      .where(eq(candidates.id, row.id));
    results.push({
      id: row.id, title: row.title, score: row.score,
      speaker: speaker || null, speakerTag: speakerHandle || null, brandTag: channelXHandle || null,
    });
  }

  if (results.length) {
    await logEvent("run", `Released ${results.length} held candidate(s) back to the render queue`);
  }
  return NextResponse.json({
    ok: true,
    released: results.length,
    batchFull: rows.length === 25, // true → more held rows remain in the window; call again
    note: "Renders start on the next scout cycle (≤30 min), paced by the normal slot/cost caps.",
    results,
  });
}
