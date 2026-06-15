import { NextRequest, NextResponse } from "next/server";
import { youtubeChannelReport } from "@/lib/pipeline/sources";
import { WATCHLIST, MAX_AGE_HOURS } from "@/lib/pipeline/config";
import { getSettings, parseWatchChannels } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Why is YouTube discovery returning 0 videos? (admin basic-auth via middleware)
//   GET /api/debug/youtube            → report at the live recency window
//   GET /api/debug/youtube?hours=336  → same channels, but a 14-day window (test if widening helps)
// Shows, per channel: the resolved id and how many uploads survive each filter (long-form →
// English → recency). If `kept` is 0 everywhere but `rawUploads` > 0, the filters (almost always
// recency) are the cause — not quota, not a bug.
export async function GET(req: NextRequest) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return NextResponse.json({ error: "YOUTUBE_API_KEY is not set" }, { status: 500 });

  const hours = Number(req.nextUrl.searchParams.get("hours") ?? MAX_AGE_HOURS);

  // Mirror the pipeline's channel selection: admin "Watched channels" override, else code WATCHLIST.
  let channels = WATCHLIST.youtubeChannels;
  let channelSource = "code WATCHLIST (settings.watch_channels empty)";
  try {
    const cfg = await getSettings();
    const fromSettings = parseWatchChannels(cfg);
    if (fromSettings.length) {
      channels = fromSettings;
      channelSource = "settings.watch_channels (admin override)";
    }
  } catch (e) {
    return NextResponse.json({ error: `settings read failed: ${(e as Error).message}` }, { status: 500 });
  }

  const report = await youtubeChannelReport(channels, key, hours);
  const totalKept = report.reduce((n, r) => n + r.kept.length, 0);
  const namesNoHandle = channels.filter((c) => !c.handle).map((c) => c.name);

  return NextResponse.json({
    effectiveWindowHours: hours,
    defaultWindowHours: MAX_AGE_HOURS,
    longFormMinMinutes: 12,
    channelSource,
    channelsConfigured: channels.length,
    channelsResolvedByNameSearch: namesNoHandle, // each costs 100 YouTube quota units/run — add handles
    totalClippableNow: totalKept,
    verdict: totalKept > 0
      ? `${totalKept} clippable video(s) at a ${hours}h window — run Scout and they should enter the pipeline.`
      : `0 clippable videos at ${hours}h. If rawUploads>0 but kept=0, widen the window (set MAX_AGE_HOURS) or add more channels. If resolvedId is null, the handle/name is wrong.`,
    report,
  }, { status: 200 });
}
