import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, xbotSeeds } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Add a seed account whose engagers get mined during discovery (Phase 3). */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const handle = String(body.handle ?? "").trim().replace(/^@/, "");
  if (!handle || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    return NextResponse.json({ ok: false, error: "valid @handle required" }, { status: 400 });
  }
  try {
    const database = db();
    const existing = await database
      .select({ id: xbotSeeds.id })
      .from(xbotSeeds)
      .where(eq(xbotSeeds.handle, handle))
      .limit(1);
    if (existing.length) {
      return NextResponse.json({ ok: false, error: `@${handle} is already a seed` }, { status: 409 });
    }
    const [created] = await database.insert(xbotSeeds).values({ handle }).returning();
    return NextResponse.json({ ok: true, seed: created });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

/** Toggle a seed active/inactive. */
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  if (!id || typeof body.active !== "boolean") {
    return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });
  }
  try {
    const [updated] = await db()
      .update(xbotSeeds)
      .set({ active: body.active })
      .where(eq(xbotSeeds.id, id))
      .returning();
    if (!updated) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true, seed: updated });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
