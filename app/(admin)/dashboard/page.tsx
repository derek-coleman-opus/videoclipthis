import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, candidates, clips, events, runs } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import RunButton from "@/components/RunButton";

export const dynamic = "force-dynamic";

function StatCard({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-sm text-neutral-400">{label}</div>
      {hint && <div className="mt-1 text-xs text-neutral-600">{hint}</div>}
    </div>
  );
}

const BADGE: Record<string, string> = {
  posted: "bg-green-900/60 text-green-300",
  replied: "bg-green-900/60 text-green-300",
  scored: "bg-blue-900/60 text-blue-300",
  found: "bg-neutral-800 text-neutral-300",
  skipped: "bg-neutral-800 text-neutral-500",
  held: "bg-amber-900/60 text-amber-300",
  error: "bg-red-900/60 text-red-300",
  run: "bg-purple-900/60 text-purple-300",
};

async function loadData() {
  const d = db();
  const one = sql<number>`count(*)::int`;
  const totalFound = Number((await d.select({ n: one }).from(candidates))[0]?.n ?? 0);
  const posted = Number((await d.select({ n: one }).from(clips).where(eq(clips.status, "posted")))[0]?.n ?? 0);
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const postedToday = Number((await d.select({ n: one }).from(clips)
    .where(and(eq(clips.status, "posted"), gte(clips.postedAt, dayStart))))[0]?.n ?? 0);
  const pending = Number((await d.select({ n: one }).from(clips).where(eq(clips.status, "pending_review")))[0]?.n ?? 0);
  const queued = Number((await d.select({ n: one }).from(clips).where(eq(clips.status, "approved")))[0]?.n ?? 0);
  const reshared = Number((await d.select({ n: one }).from(clips).where(eq(clips.resharedBySpeaker, true)))[0]?.n ?? 0);
  const recent = await d.select().from(events).orderBy(desc(events.createdAt)).limit(30);
  const lastRun = (await d.select().from(runs).orderBy(desc(runs.startedAt)).limit(1))[0];
  const cfg = await getSettings();
  return { totalFound, posted, postedToday, pending, queued, reshared, recent, lastRun, cfg };
}

export default async function Dashboard() {
  let data: Awaited<ReturnType<typeof loadData>>;
  try {
    data = await loadData();
  } catch (e) {
    return (
      <div className="rounded-lg border border-amber-800 bg-amber-950/40 p-4 text-sm">
        <p className="font-medium text-amber-300">Database not ready</p>
        <p className="mt-1 text-neutral-300">{(e as Error).message}</p>
        <p className="mt-2 text-neutral-400">
          Set <code>DATABASE_URL</code>, run <code>npm run db:push</code>, then click{" "}
          “Run Scout now”.
        </p>
      </div>
    );
  }
  const { totalFound, posted, postedToday, pending, queued, reshared, recent, lastRun, cfg } = data;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap gap-2">
          {cfg.paused && <span className="rounded bg-red-900/60 px-2 py-0.5 text-xs text-red-300">PAUSED</span>}
          <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300">autonomy: {cfg.autonomy}</span>
        </div>
        <RunButton />
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Posted today" value={`${postedToday} / ${cfg.dailyClipCap ?? 6}`} hint="auto-post cap" />
        <StatCard label="Queued to post" value={queued} hint="approved, waiting for a paced slot" />
        <StatCard label="In review" value={pending} />
        <StatCard label="Posted (all time)" value={posted} />
        <StatCard label="Found" value={totalFound} />
        <StatCard label="Reshared by speaker" value={reshared} hint="credit-first loop" />
      </div>

      <div>
        <h2 className="mb-2 text-sm font-medium text-neutral-400">
          Activity{lastRun && lastRun.startedAt ? ` · last run ${new Date(lastRun.startedAt).toLocaleString()}` : ""}
        </h2>
        <ul className="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
          {recent.length === 0 && (
            <li className="p-3 text-sm text-neutral-500">No activity yet. Hit “Run Scout now”.</li>
          )}
          {recent.map((e) => (
            <li key={e.id} className="flex items-center gap-3 p-3 text-sm">
              <span className={`rounded px-2 py-0.5 text-xs ${BADGE[e.type] ?? "bg-neutral-800 text-neutral-300"}`}>
                {e.type}
              </span>
              <span className="text-neutral-200">{e.message}</span>
              <span className="ml-auto shrink-0 text-xs text-neutral-600">
                {e.createdAt ? new Date(e.createdAt).toLocaleTimeString() : ""}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
