import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, xbotTargets } from "@/lib/db";

export const dynamic = "force-dynamic";

const ALLOWED_STATUSES = ["candidate", "active", "cooldown", "archived", "blocked"];

/** Update a target's status (archive, block, reactivate). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: idParam } = await params;
  const id = Number(idParam);
  const body = await req.json().catch(() => ({}));
  const status = String(body.status ?? "");
  if (!id || !ALLOWED_STATUSES.includes(status)) {
    return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });
  }
  try {
    const [updated] = await db()
      .update(xbotTargets)
      .set({ status })
      .where(eq(xbotTargets.id, id))
      .returning();
    if (!updated) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true, target: updated });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
