import { NextRequest, NextResponse } from "next/server";
import { addFigure } from "@/lib/figures-store";

export const dynamic = "force-dynamic";

// Add a tracked figure. Admin basic-auth (middleware).
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  if (!b?.name || !b?.xHandle) {
    return NextResponse.json({ ok: false, error: "name and xHandle are required" }, { status: 400 });
  }
  try {
    const figure = await addFigure({
      name: String(b.name),
      xHandle: String(b.xHandle),
      org: b.org != null ? String(b.org) : undefined,
      role: b.role != null ? String(b.role) : undefined,
      priority: b.priority != null ? Number(b.priority) : undefined,
      youtubeChannelId: b.youtubeChannelId != null ? String(b.youtubeChannelId) : undefined,
    });
    if (!figure) {
      return NextResponse.json({ ok: false, error: "that @handle is already tracked" }, { status: 409 });
    }
    return NextResponse.json({ ok: true, figure });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
