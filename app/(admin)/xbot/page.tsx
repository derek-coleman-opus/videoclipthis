import Link from "next/link";
import { and, desc, eq, gte, like } from "drizzle-orm";
import { db, events, xbotActions, xbotDrafts, xbotTargets } from "@/lib/db";
import { getXbotSettings, parseSetupChecklist } from "@/lib/xbot/settings";
import { hasXbotWriteEnv } from "@/lib/xbot/env";
import { inQuietHours } from "@/lib/xbot/guards";
import { TARGET_ROSTER_GOAL } from "@/lib/xbot/config";
import { SETUP_ITEMS } from "@/lib/xbot/playbook";
import { timeAgo } from "@/lib/timeago";
import XbotInboundButton from "@/components/XbotInboundButton";
import XbotOutboundButton from "@/components/XbotOutboundButton";
import XbotDiscoverButton from "@/components/XbotDiscoverButton";
import XbotPostDueButton from "@/components/XbotPostDueButton";
import XbotAutonomyPreset from "@/components/XbotAutonomyPreset";

export const dynamic = "force-dynamic";

export default async function XbotPage() {
  let data: Awaited<ReturnType<typeof load>>;
  try {
    data = await load();
  } catch (e) {
    return <div className="text-sm text-amber-300">Database not ready: {(e as Error).message}</div>;
  }
  const { settings, today, pending, targetCount, engagedBack, feed, hasCreds, setupDone, lastActionAt } = data;
  const notReady = !settings.voiceNotes?.trim() || !settings.mission?.trim();
  const quietNow = inQuietHours(settings);

  const stats: Array<[string, string]> = [
    ["Replies today", `${today.reply} / ${settings.dailyReplyCap}`],
    ["Engage-backs today", `${today.engage} / ${settings.dailyEngageCap}`],
    ["Likes today", `${today.like} / ${settings.dailyLikeCap}`],
    ["Posts today", `${today.post} / ${settings.dailyPostCap}`],
    ["Last action", lastActionAt ? timeAgo(lastActionAt) : "never"],
    ["Pending review", String(pending)],
    ["Target roster", `${targetCount} / ${TARGET_ROSTER_GOAL}+`],
    ["Engaged back", String(engagedBack)],
  ];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-medium text-neutral-400">XBot — personal account growth</h2>
        <div className="flex gap-3 text-xs">
          {setupDone < SETUP_ITEMS.length && (
            <Link href="/xbot/playbook" className="rounded bg-amber-900/50 px-2 py-1 text-amber-300 hover:underline">
              setup {setupDone}/{SETUP_ITEMS.length} — finish the playbook checklist
            </Link>
          )}
        </div>
      </div>

      {/* State banner: when the bot cannot act, say so LOUDLY and say exactly why. A paused
          default once no-opped every cron for days with nothing but a tiny badge. */}
      {settings.paused ? (
        <div className="mb-4 rounded-lg border border-red-800 bg-red-950/50 p-3 text-sm text-red-200">
          <b>⏸ XBot is PAUSED — the crons are firing but doing nothing.</b> No likes, no replies,
          no posts until you pick an autonomy mode below (🚀 Growth autopilot for the volume push).
        </div>
      ) : !hasCreds ? (
        <div className="mb-4 rounded-lg border border-red-800 bg-red-950/50 p-3 text-sm text-red-200">
          <b>X credentials not configured</b> — drafting-only mode. Set the <code>XBOT_*</code> env
          vars in Vercel to enable liking and posting.
        </div>
      ) : quietNow ? (
        <div className="mb-4 rounded-lg border border-amber-800 bg-amber-950/40 p-3 text-xs text-amber-200">
          🌙 Quiet hours ({String(settings.quietStartUtc).padStart(2, "0")}:00–
          {String(settings.quietEndUtc).padStart(2, "0")}:00 UTC): drafting continues, but likes and
          posts hold until the window ends.
        </div>
      ) : null}

      <XbotAutonomyPreset
        paused={settings.paused}
        replyAutonomy={settings.replyAutonomy}
        postAutonomy={settings.postAutonomy}
        dailyLikeCap={settings.dailyLikeCap}
      />

      {notReady && (
        <div className="mb-6 rounded-lg border border-amber-800/60 bg-amber-900/20 p-3 text-xs text-amber-200">
          Set your <b>Mission</b> and <b>Voice notes</b> in{" "}
          <Link href="/xbot/settings" className="underline">XBot Settings</Link> before going hands-off —
          the drafts lean on them to sound like you.
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-lg border border-neutral-800 p-3">
            <div className="text-xs text-neutral-500">{label}</div>
            <div className="text-lg font-semibold">{value}</div>
          </div>
        ))}
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3 text-sm">
        <Link href="/xbot/activity" className="rounded-md bg-white px-3 py-1.5 font-medium text-black hover:bg-neutral-200">
          Activity
        </Link>
        <Link href="/xbot/queue" className="rounded-md bg-white px-3 py-1.5 font-medium text-black hover:bg-neutral-200">
          Review queue {pending > 0 ? `(${pending})` : ""}
        </Link>
        <XbotDiscoverButton disabled={!hasCreds} />
        <XbotOutboundButton disabled={!hasCreds} />
        <XbotInboundButton disabled={!hasCreds} />
        <XbotPostDueButton disabled={!hasCreds} />
        <Link href="/xbot/targets" className="rounded-md border border-neutral-600 px-3 py-1.5 text-neutral-200 hover:bg-neutral-800">
          Manage targets
        </Link>
        <Link href="/xbot/playbook" className="rounded-md border border-neutral-600 px-3 py-1.5 text-neutral-200 hover:bg-neutral-800">
          Playbook
        </Link>
      </div>

      <h3 className="mb-2 text-sm font-medium text-neutral-400">Recent activity</h3>
      <ul className="space-y-1 text-sm">
        {feed.map((e) => (
          <li key={e.id} className="flex gap-3 border-b border-neutral-900 py-1">
            <span className="w-40 shrink-0 text-xs text-neutral-600">
              {e.createdAt ? new Date(e.createdAt).toLocaleString() : ""}
            </span>
            <span className="w-28 shrink-0 text-xs text-neutral-500">{e.type.replace("xbot_", "")}</span>
            <span className="text-neutral-300">{e.message}</span>
          </li>
        ))}
        {feed.length === 0 && <li className="text-neutral-500">No XBot activity yet.</li>}
      </ul>
    </div>
  );
}

async function load() {
  const database = db();
  const settings = await getXbotSettings();

  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const todayActions = await database
    .select({ kind: xbotActions.kind })
    .from(xbotActions)
    .where(gte(xbotActions.createdAt, dayStart));
  const today = { reply: 0, like: 0, post: 0, engage: 0 } as Record<string, number>;
  for (const a of todayActions) today[a.kind] = (today[a.kind] ?? 0) + 1;

  const pending = (await database
    .select({ id: xbotDrafts.id })
    .from(xbotDrafts)
    .where(eq(xbotDrafts.status, "pending_review"))).length;
  const targetCount = (await database
    .select({ id: xbotTargets.id })
    .from(xbotTargets)).length;
  const engagedBack = (await database
    .select({ id: xbotTargets.id })
    .from(xbotTargets)
    .where(eq(xbotTargets.engagedBack, true))).length;

  const feed = await database
    .select()
    .from(events)
    .where(like(events.type, "xbot%"))
    .orderBy(desc(events.createdAt))
    .limit(30);

  // Heartbeat: the most recent ledger action — makes silence visible on the dashboard.
  const lastAction = (await database
    .select({ createdAt: xbotActions.createdAt })
    .from(xbotActions)
    .orderBy(desc(xbotActions.createdAt))
    .limit(1))[0];

  return {
    settings, today, pending, targetCount, engagedBack, feed,
    lastActionAt: lastAction?.createdAt ?? null,
    hasCreds: hasXbotWriteEnv(),
    setupDone: parseSetupChecklist(settings).filter((id) => SETUP_ITEMS.some((i) => i.id === id)).length,
  };
}
