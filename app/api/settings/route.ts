import { NextRequest, NextResponse } from "next/server";
import { updateSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const patch: { paused?: boolean; threshold?: number; autonomy?: string } = {};
  if (typeof body.paused === "boolean") patch.paused = body.paused;
  if (typeof body.threshold === "number") patch.threshold = body.threshold;
  if (typeof body.autonomy === "string" && ["review", "assisted", "auto"].includes(body.autonomy)) {
    patch.autonomy = body.autonomy;
  }
  try {
    const updated = await updateSettings(patch);
    return NextResponse.json({ ok: true, settings: updated });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
