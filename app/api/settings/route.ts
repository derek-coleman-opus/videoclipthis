import { NextRequest, NextResponse } from "next/server";
import { switchProfile, updateSettings } from "@/lib/settings";
import { PROFILES } from "@/lib/pipeline/audience";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));

  // Switching the audience profile is its own operation, not a field write: it has to snapshot the
  // outgoing profile's topics/channels and load the incoming one's. Handled first and returned
  // early so a switch can never be mixed with edits to the fields it is about to overwrite.
  if (typeof body.switchProfile === "string") {
    if (!PROFILES.some((p) => p.key === body.switchProfile)) {
      return NextResponse.json(
        { ok: false, error: `unknown profile "${body.switchProfile}"` },
        { status: 400 },
      );
    }
    try {
      const updated = await switchProfile(body.switchProfile);
      return NextResponse.json({ ok: true, settings: updated });
    } catch (e) {
      return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
    }
  }

  const patch: {
    paused?: boolean; threshold?: number; autonomy?: string; dailyClipCap?: number;
    niche?: string; watchChannels?: string; opusBrandTemplateId?: string | null; searchTopics?: string;
    crosspostAccounts?: string; curationBrief?: string;
  } = {};
  if (typeof body.paused === "boolean") patch.paused = body.paused;
  if (typeof body.threshold === "number") patch.threshold = body.threshold;
  if (typeof body.autonomy === "string" && ["review", "auto"].includes(body.autonomy)) {
    patch.autonomy = body.autonomy;
  }
  if (typeof body.dailyClipCap === "number" && Number.isFinite(body.dailyClipCap) && body.dailyClipCap >= 0) {
    patch.dailyClipCap = Math.round(body.dailyClipCap);
  }
  if (typeof body.niche === "string") patch.niche = body.niche.trim();
  if (typeof body.watchChannels === "string") patch.watchChannels = body.watchChannels;
  if (typeof body.opusBrandTemplateId === "string") {
    patch.opusBrandTemplateId = body.opusBrandTemplateId.trim() || null;
  }
  if (typeof body.searchTopics === "string") patch.searchTopics = body.searchTopics;
  // Blank is meaningful: it means "use the active profile's brief", so it is not trimmed away.
  if (typeof body.curationBrief === "string") patch.curationBrief = body.curationBrief;
  if (typeof body.crosspostAccounts === "string") {
    try {
      const arr = JSON.parse(body.crosspostAccounts);
      if (!Array.isArray(arr)) throw new Error("not an array");
      // Keep only well-formed account entries — this JSON drives real posts.
      patch.crosspostAccounts = JSON.stringify(
        arr
          .map((a: any) => ({
            postAccountId: String(a?.postAccountId ?? ""),
            subAccountId: a?.subAccountId ? String(a.subAccountId) : null,
            platform: String(a?.platform ?? ""),
            name: String(a?.name ?? ""),
          }))
          .filter((a) => a.postAccountId && a.platform),
      );
    } catch {
      return NextResponse.json(
        { ok: false, error: "crosspostAccounts must be a JSON array of accounts" },
        { status: 400 },
      );
    }
  }
  try {
    const updated = await updateSettings(patch);
    return NextResponse.json({ ok: true, settings: updated });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
