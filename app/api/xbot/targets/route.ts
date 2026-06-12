import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, xbotTargets } from "@/lib/db";
import { logEvent } from "@/lib/pipeline/events";

export const dynamic = "force-dynamic";

/** Manually add a target account. Works with zero X credentials — the handle (plus
 *  whatever bio/follower info the admin pastes in) is enough to start drafting. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const handle = String(body.handle ?? "").trim().replace(/^@/, "");
  if (!handle || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    return NextResponse.json({ ok: false, error: "valid @handle required" }, { status: 400 });
  }
  try {
    const database = db();
    const existing = await database
      .select({ id: xbotTargets.id })
      .from(xbotTargets)
      .where(eq(xbotTargets.handle, handle))
      .limit(1);
    if (existing.length) {
      return NextResponse.json({ ok: false, error: `@${handle} is already a target` }, { status: 409 });
    }
    const [created] = await database.insert(xbotTargets).values({
      handle,
      displayName: String(body.displayName ?? "").trim(),
      bio: String(body.bio ?? "").trim(),
      followers: Number.isFinite(Number(body.followers)) ? Math.max(0, Math.round(Number(body.followers))) : 0,
      source: "manual",
      status: "active",
    }).returning();
    await logEvent("xbot_found", `Target added manually: @${handle}`, "xbot_targets", created.id);
    return NextResponse.json({ ok: true, target: created });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
