import { NextRequest, NextResponse } from "next/server";
import { updateSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const patch: {
    paused?: boolean; threshold?: number; autonomy?: string;
    niche?: string; watchChannels?: string; opusBrandTemplateId?: string | null; searchTopics?: string;
  } = {};
  if (typeof body.paused === "boolean") patch.paused = body.paused;
  if (typeof body.threshold === "number") patch.threshold = body.threshold;
  if (typeof body.autonomy === "string" && ["review", "assisted", "auto"].includes(body.autonomy)) {
    patch.autonomy = body.autonomy;
  }
  if (typeof body.niche === "string") patch.niche = body.niche.trim();
  if (typeof body.watchChannels === "string") patch.watchChannels = body.watchChannels;
  if (typeof body.opusBrandTemplateId === "string") {
    patch.opusBrandTemplateId = body.opusBrandTemplateId.trim() || null;
  }
  if (typeof body.searchTopics === "string") patch.searchTopics = body.searchTopics;
  try {
    const updated = await updateSettings(patch);
    return NextResponse.json({ ok: true, settings: updated });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
