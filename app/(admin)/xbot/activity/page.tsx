import Link from "next/link";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db, xbotActions, xbotDrafts, xbotTweets } from "@/lib/db";
import { timeAgo } from "@/lib/timeago";

export const dynamic = "force-dynamic";

// Every action the XBot took, time-bucketed and clickable — the "is it actually working" page.
// Ground truth is the xbot_actions ledger ((kind, createdAt) indexed); rows are enriched by
// joining likes → xbot_tweets (author + text of the liked post) and replies/posts/engage →
// xbot_drafts via xPostId (our text + what we replied to).

const WINDOWS: Array<[label: string, hours: number]> = [
  ["1h", 1], ["4h", 4], ["8h", 8], ["24h", 24], ["7d", 168],
];
const KINDS = ["like", "reply", "engage", "post"] as const;

const KIND_BADGE: Record<string, string> = {
  like: "bg-pink-900/60 text-pink-300",
  reply: "bg-blue-900/60 text-blue-300",
  engage: "bg-green-900/60 text-green-300",
  post: "bg-purple-900/60 text-purple-300",
};

interface ActivityRow {
  id: number;
  kind: string;
  createdAt: Date | null;
  tweetId: string | null;
  handle: string;   // who we engaged (liked author / replied-to target) or "" if unknown
  text: string;     // liked-post text, or our reply/post text
  url: string;      // link to the post on X
}

export default async function XbotActivityPage({
  searchParams,
}: { searchParams: Promise<{ kind?: string; window?: string }> }) {
  const params = await searchParams;
  const kindFilter = KINDS.includes(params.kind as any) ? (params.kind as string) : null;
  const windowH = WINDOWS.some(([l]) => l === params.window)
    ? WINDOWS.find(([l]) => l === params.window)![1]
    : 24;

  let data: Awaited<ReturnType<typeof load>>;
  try {
    data = await load(kindFilter, windowH);
  } catch (e) {
    return <div className="text-sm text-amber-300">Database not ready: {(e as Error).message}</div>;
  }
  const { buckets, rows } = data;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-medium text-neutral-400">XBot activity</h2>
        <Link href="/xbot" className="text-xs text-neutral-500 hover:underline">← dashboard</Link>
      </div>

      {/* Time-bucket tiles: kind × window counts */}
      <div className="mb-6 overflow-x-auto">
        <table className="w-full min-w-[480px] text-sm">
          <thead>
            <tr className="text-left text-xs text-neutral-500">
              <th className="py-1 pr-4 font-normal">window</th>
              {KINDS.map((k) => <th key={k} className="py-1 pr-4 font-normal">{k}s</th>)}
              <th className="py-1 font-normal">total</th>
            </tr>
          </thead>
          <tbody>
            {WINDOWS.map(([label, hours]) => {
              const b = buckets[label] ?? {};
              const total = KINDS.reduce((n, k) => n + (b[k] ?? 0), 0);
              return (
                <tr key={label} className="border-t border-neutral-900">
                  <td className="py-1.5 pr-4 text-neutral-400">last {label}</td>
                  {KINDS.map((k) => (
                    <td key={k} className="py-1.5 pr-4 font-medium">{b[k] ?? 0}</td>
                  ))}
                  <td className="py-1.5 font-semibold">{total}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Filters */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-neutral-500">show:</span>
        <FilterChip href={`/xbot/activity?window=${labelFor(windowH)}`} active={!kindFilter} label="all" />
        {KINDS.map((k) => (
          <FilterChip
            key={k}
            href={`/xbot/activity?kind=${k}&window=${labelFor(windowH)}`}
            active={kindFilter === k}
            label={`${k}s`}
          />
        ))}
        <span className="ml-3 text-neutral-500">window:</span>
        {WINDOWS.map(([label]) => (
          <FilterChip
            key={label}
            href={`/xbot/activity?${kindFilter ? `kind=${kindFilter}&` : ""}window=${label}`}
            active={labelFor(windowH) === label}
            label={label}
          />
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
            No {kindFilter ?? ""} actions in the last {labelFor(windowH)}. If this stays empty with
            the bot unpaused, check the dashboard banner and /api/admin/diagnostics.
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

function labelFor(hours: number): string {
  return WINDOWS.find(([, h]) => h === hours)?.[0] ?? "24h";
}

async function load(kindFilter: string | null, windowH: number) {
  const database = db();

  // Bucket counts: one query over the widest window, bucketed in memory (7d of actions at
  // growth volume ≈ a few thousand rows — fine, and it keeps this a single indexed scan).
  const since7d = new Date(Date.now() - 168 * 3600 * 1000);
  const recent = await database
    .select({ kind: xbotActions.kind, createdAt: xbotActions.createdAt })
    .from(xbotActions)
    .where(gte(xbotActions.createdAt, since7d));
  const buckets: Record<string, Record<string, number>> = {};
  for (const [label, hours] of WINDOWS) {
    const cutoff = Date.now() - hours * 3600 * 1000;
    const b: Record<string, number> = {};
    for (const a of recent) {
      if (!a.createdAt || a.createdAt.getTime() < cutoff) continue;
      b[a.kind] = (b[a.kind] ?? 0) + 1;
    }
    buckets[label] = b;
  }

  // Action list, enriched for display + linking.
  const cutoff = new Date(Date.now() - windowH * 3600 * 1000);
  const actions = await database
    .select()
    .from(xbotActions)
    .where(
      kindFilter
        ? and(gte(xbotActions.createdAt, cutoff), eq(xbotActions.kind, kindFilter))
        : gte(xbotActions.createdAt, cutoff),
    )
    .orderBy(desc(xbotActions.createdAt))
    .limit(100);

  // Enrich: likes → the liked tweet (author + text); reply/engage/post → our draft (text) via xPostId.
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

  return { buckets, rows };
}
