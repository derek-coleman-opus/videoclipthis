import Link from "next/link";
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { db, xbotActions, xbotDrafts, xbotTweets } from "@/lib/db";
import XbotRangeSelect from "@/components/XbotRangeSelect";
import { timeAgo } from "@/lib/timeago";

export const dynamic = "force-dynamic";

// Every action the XBot took — range-selectable metrics, per-day breakdown, and a clickable
// action list. Ground truth is the xbot_actions ledger ((kind, createdAt) indexed); rows are
// enriched by joining likes → xbot_tweets (author + text of the liked post) and
// replies/posts/engage → xbot_drafts via xPostId.

const KINDS = ["like", "reply", "engage", "post"] as const;
const BUCKETS: Array<[label: string, hours: number]> = [
  ["1h", 1], ["4h", 4], ["8h", 8], ["24h", 24], ["7d", 168],
];

const KIND_BADGE: Record<string, string> = {
  like: "bg-pink-900/60 text-pink-300",
  reply: "bg-blue-900/60 text-blue-300",
  engage: "bg-green-900/60 text-green-300",
  post: "bg-purple-900/60 text-purple-300",
};

type RangeKey = "today" | "yesterday" | "24h" | "7d" | "30d";
const RANGE_KEYS: RangeKey[] = ["today", "yesterday", "24h", "7d", "30d"];

/** [start, end) bounds for a range. Calendar ranges use UTC day boundaries. */
function rangeBounds(range: RangeKey): { start: Date; end: Date; days: number } {
  const now = new Date();
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  switch (range) {
    case "today":
      return { start: dayStart, end: now, days: 1 };
    case "yesterday": {
      const start = new Date(dayStart.getTime() - 86400_000);
      return { start, end: dayStart, days: 1 };
    }
    case "24h":
      return { start: new Date(now.getTime() - 24 * 3600_000), end: now, days: 1 };
    case "7d":
      return { start: new Date(now.getTime() - 7 * 86400_000), end: now, days: 7 };
    case "30d":
      return { start: new Date(now.getTime() - 30 * 86400_000), end: now, days: 30 };
  }
}

interface ActivityRow {
  id: number;
  kind: string;
  createdAt: Date | null;
  tweetId: string | null;
  handle: string;   // who we engaged (liked author) or "" if unknown
  text: string;     // liked-post text, or our reply/post text
  url: string;      // link to the post on X
}

export default async function XbotActivityPage({
  searchParams,
}: { searchParams: Promise<{ kind?: string; range?: string }> }) {
  const params = await searchParams;
  const kindFilter = KINDS.includes(params.kind as any) ? (params.kind as string) : null;
  const range: RangeKey = RANGE_KEYS.includes(params.range as RangeKey) ? (params.range as RangeKey) : "24h";

  let data: Awaited<ReturnType<typeof load>>;
  try {
    data = await load(kindFilter, range);
  } catch (e) {
    return <div className="text-sm text-amber-300">Database not ready: {(e as Error).message}</div>;
  }
  const { summary, buckets, perDay, rows } = data;
  const total = KINDS.reduce((n, k) => n + (summary[k] ?? 0), 0);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-medium text-neutral-400">XBot activity</h2>
        <div className="flex items-center gap-3">
          <XbotRangeSelect range={range} kind={kindFilter} />
          <Link href="/xbot" className="text-xs text-neutral-500 hover:underline">← dashboard</Link>
        </div>
      </div>

      {/* Selected-range summary */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {KINDS.map((k) => (
          <div key={k} className="rounded-lg border border-neutral-800 p-3">
            <div className="text-xs text-neutral-500">{k}s</div>
            <div className="text-lg font-semibold">{summary[k] ?? 0}</div>
          </div>
        ))}
        <div className="rounded-lg border border-neutral-800 p-3">
          <div className="text-xs text-neutral-500">total</div>
          <div className="text-lg font-semibold">{total}</div>
        </div>
      </div>

      {/* Per-day breakdown for multi-day ranges — "how active was it each day" */}
      {perDay.length > 1 && (
        <div className="mb-6 overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <thead>
              <tr className="text-left text-xs text-neutral-500">
                <th className="py-1 pr-4 font-normal">day (UTC)</th>
                {KINDS.map((k) => <th key={k} className="py-1 pr-4 font-normal">{k}s</th>)}
                <th className="py-1 font-normal">total</th>
              </tr>
            </thead>
            <tbody>
              {perDay.map((d) => (
                <tr key={d.date} className="border-t border-neutral-900">
                  <td className="py-1.5 pr-4 text-neutral-400">{d.date}</td>
                  {KINDS.map((k) => <td key={k} className="py-1.5 pr-4 font-medium">{d.counts[k] ?? 0}</td>)}
                  <td className="py-1.5 font-semibold">{KINDS.reduce((n, k) => n + (d.counts[k] ?? 0), 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Rolling-window strip (always-on pulse check) */}
      <div className="mb-6 flex flex-wrap gap-4 text-xs text-neutral-500">
        {BUCKETS.map(([label]) => {
          const b = buckets[label] ?? {};
          const t = KINDS.reduce((n, k) => n + (b[k] ?? 0), 0);
          return (
            <span key={label}>
              last {label}: <b className="text-neutral-300">{t}</b>
              {t > 0 && <span> ({KINDS.filter((k) => b[k]).map((k) => `${b[k]} ${k}`).join(", ")})</span>}
            </span>
          );
        })}
      </div>

      {/* Kind filter chips */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-neutral-500">show:</span>
        <FilterChip href={`/xbot/activity?range=${range}`} active={!kindFilter} label="all" />
        {KINDS.map((k) => (
          <FilterChip key={k} href={`/xbot/activity?kind=${k}&range=${range}`} active={kindFilter === k} label={`${k}s`} />
        ))}
      </div>

      {/* Clickable action list */}
      <ul className="space-y-1 text-sm">
        {rows.map((r) => (
          <li key={r.id} className="flex items-start gap-3 border-b border-neutral-900 py-1.5">
            <span className="w-16 shrink-0 text-xs text-neutral-600">{timeAgo(r.createdAt)}</span>
            <span className={`w-16 shrink-0 rounded px-1.5 py-0.5 text-center text-xs ${KIND_BADGE[r.kind] ?? "bg-neutral-800 text-neutral-400"}`}>
              {r.kind}
            </span>
            <span className="min-w-0 flex-1 truncate text-neutral-300" title={r.text}>
              {r.handle && <span className="text-neutral-500">@{r.handle} · </span>}
              {r.text || <span className="text-neutral-600">(no text captured)</span>}
            </span>
            {r.url && (
              <a href={r.url} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-neutral-400 underline hover:text-neutral-200">
                open on X ↗
              </a>
            )}
          </li>
        ))}
        {rows.length === 0 && (
          <li className="py-4 text-neutral-500">
            No {kindFilter ?? ""} actions in this range. If this stays empty with the bot unpaused,
            check the dashboard health banner and /api/admin/diagnostics.
          </li>
        )}
      </ul>
    </div>
  );
}

function FilterChip({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={`rounded px-2 py-0.5 ${active ? "bg-white font-medium text-black" : "border border-neutral-700 text-neutral-300 hover:bg-neutral-800"}`}
    >
      {label}
    </Link>
  );
}

async function load(kindFilter: string | null, range: RangeKey) {
  const database = db();
  const { start, end } = rangeBounds(range);

  // One indexed scan covers everything we aggregate: the wider of (selected range, 7d strip).
  const scanStart = new Date(Math.min(start.getTime(), Date.now() - 168 * 3600_000));
  const recent = await database
    .select({ kind: xbotActions.kind, createdAt: xbotActions.createdAt })
    .from(xbotActions)
    .where(gte(xbotActions.createdAt, scanStart));

  // Selected-range summary.
  const summary: Record<string, number> = {};
  for (const a of recent) {
    if (!a.createdAt || a.createdAt < start || a.createdAt >= end) continue;
    summary[a.kind] = (summary[a.kind] ?? 0) + 1;
  }

  // Rolling-window strip (independent of the selected range).
  const buckets: Record<string, Record<string, number>> = {};
  for (const [label, hours] of BUCKETS) {
    const cutoff = Date.now() - hours * 3600_000;
    const b: Record<string, number> = {};
    for (const a of recent) {
      if (!a.createdAt || a.createdAt.getTime() < cutoff) continue;
      b[a.kind] = (b[a.kind] ?? 0) + 1;
    }
    buckets[label] = b;
  }

  // Per-day breakdown across the selected range (UTC dates, newest first).
  const perDayMap = new Map<string, Record<string, number>>();
  for (const a of recent) {
    if (!a.createdAt || a.createdAt < start || a.createdAt >= end) continue;
    const date = a.createdAt.toISOString().slice(0, 10);
    const counts = perDayMap.get(date) ?? {};
    counts[a.kind] = (counts[a.kind] ?? 0) + 1;
    perDayMap.set(date, counts);
  }
  const perDay = [...perDayMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, counts]) => ({ date, counts }));

  // Action list for the selected range (+ kind filter), newest first, capped at 100.
  const conds = [gte(xbotActions.createdAt, start), lt(xbotActions.createdAt, end)];
  if (kindFilter) conds.push(eq(xbotActions.kind, kindFilter));
  const actions = await database
    .select().from(xbotActions)
    .where(and(...conds))
    .orderBy(desc(xbotActions.createdAt))
    .limit(100);

  // Enrich: likes → the liked tweet (author + text); reply/engage/post → our draft via xPostId.
  const likeIds = actions.filter((a) => a.kind === "like" && a.tweetId).map((a) => a.tweetId as string);
  const postIds = actions.filter((a) => a.kind !== "like" && a.tweetId).map((a) => a.tweetId as string);
  const likedTweets = likeIds.length
    ? await database.select().from(xbotTweets).where(inArray(xbotTweets.tweetId, likeIds))
    : [];
  const drafts = postIds.length
    ? await database.select().from(xbotDrafts).where(inArray(xbotDrafts.xPostId, postIds))
    : [];
  const tweetById = new Map(likedTweets.map((t) => [t.tweetId, t]));
  const draftByPostId = new Map(drafts.map((d) => [d.xPostId as string, d]));

  const rows: ActivityRow[] = actions.map((a) => {
    if (a.kind === "like") {
      const t = a.tweetId ? tweetById.get(a.tweetId) : undefined;
      return {
        id: a.id, kind: a.kind, createdAt: a.createdAt, tweetId: a.tweetId,
        handle: t?.authorHandle ?? "",
        text: t?.text ?? "",
        url: a.tweetId
          ? (t?.authorHandle ? `https://x.com/${t.authorHandle}/status/${a.tweetId}` : `https://x.com/i/status/${a.tweetId}`)
          : "",
      };
    }
    const d = a.tweetId ? draftByPostId.get(a.tweetId) : undefined;
    return {
      id: a.id, kind: a.kind, createdAt: a.createdAt, tweetId: a.tweetId,
      handle: "",
      text: d?.text ?? "",
      url: a.tweetId ? `https://x.com/i/status/${a.tweetId}` : "",
    };
  });

  return { summary, buckets, perDay, rows };
}
