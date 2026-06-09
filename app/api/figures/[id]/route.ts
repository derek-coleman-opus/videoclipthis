import { NextRequest, NextResponse } from "next/server";
import { deleteFigure } from "@/lib/figures-store";

export const dynamic = "force-dynamic";

// Remove a tracked figure by id. Admin basic-auth (middleware).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const n = Number(id);
  if (!Number.isFinite(n)) {
    return NextResponse.json({ ok: false, error: "bad id" }, { status: 400 });
  }
  try {
    await deleteFigure(n);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
