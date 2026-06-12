import { NextRequest, NextResponse } from "next/server";
import { updateXbotSettings, type XbotSettingsPatch } from "@/lib/xbot/settings";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const patch: XbotSettingsPatch = {};
  if (typeof body.paused === "boolean") patch.paused = body.paused;
  if (typeof body.likesAuto === "boolean") patch.likesAuto = body.likesAuto;
  for (const key of ["replyAutonomy", "postAutonomy"] as const) {
    if (typeof body[key] === "string" && ["review", "auto"].includes(body[key])) patch[key] = body[key];
  }
  for (const key of [
    "dailyReplyCap", "dailyLikeCap", "dailyPostCap", "cooldownDays",
    "quietStartUtc", "quietEndUtc", "maxFollowers",
  ] as const) {
    if (typeof body[key] === "number" && Number.isFinite(body[key]) && body[key] >= 0) {
      patch[key] = Math.round(body[key]);
    }
  }
  if (typeof body.voiceNotes === "string") patch.voiceNotes = body.voiceNotes;
  if (typeof body.mission === "string") patch.mission = body.mission.trim();
  if (typeof body.productUrl === "string") patch.productUrl = body.productUrl.trim();
  if (typeof body.communityId === "string") patch.communityId = body.communityId.trim();
  for (const key of ["keywords", "setupChecklist"] as const) {
    if (typeof body[key] !== "string") continue;
    try {
      const arr = JSON.parse(body[key]);
      if (!Array.isArray(arr)) throw new Error("not an array");
      patch[key] = JSON.stringify(arr.map(String).filter(Boolean));
    } catch {
      return NextResponse.json({ ok: false, error: `${key} must be a JSON array of strings` }, { status: 400 });
    }
  }
  try {
    const updated = await updateXbotSettings(patch);
    return NextResponse.json({ ok: true, settings: updated });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
