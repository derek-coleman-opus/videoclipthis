import { desc, eq, inArray } from "drizzle-orm";
import { db, candidates, clips, summonRequests } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { getXbotHealth } from "@/lib/xbot/health";
import { timeAgo } from "@/lib/timeago";

export const dynamic = "force-dynamic";

/** The Summon console: is the mention poll alive, what tags came in, what video each one
 *  points at, and where its clip is in the pipeline. A user tagging the bot and seeing
 *  nothing MUST be explainable from this page alone. */
export default async function RepliesPage() {
  let data: Awaited<ReturnType<typeof load>>;
  try {
    data = await load();
  } catch (e) {
    return <div className="text-sm text-amber-300">Database not ready: {(e as Error).message}</div>;
  }
  const { rows, poll, botUserId } = data;

  const pollFailing = poll?.lastErrorAt && (!poll.lastOkAt || poll.lastErrorAt >= poll.lastOkAt);

  const STATUS_HINT: Record<string, string> = {
    received: "seen — about to submit the render",
    clipped: "rendering — clip reply follows in ~5–15 min",
    replied: "done — clip posted in the thread",
    rejected: "refused (unsupported host / too short / safety)",
    no_video: "no video link found — instructions reply sent",
    failed: "render or reply errored — see the event feed",
  };

  return (
    <div>
      <h2 className="mb-3 text-sm font-medium text-neutral-400">Summon — @mentions → clip replies</h2>

      {/* Poll health: the #1 question this page must answer is "is anything even listening?" */}
      {!poll ? (
        <div className="mb-4 rounded-lg border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-200">
          ⚠ The mention poll has <b>never reported a run</b>. It runs every 5 minutes via Vercel
          Cron — if this doesn&apos;t change within 10 minutes, the cron isn&apos;t firing or is
          crashing before the poll; check /api/admin/diagnostics and the Vercel logs for
          /api/cron/summon.
        </div>
      ) : pollFailing ? (
        <div className="mb-4 rounded-lg border border-red-800 bg-red-950/50 p-3 text-sm text-red-200">
          🚨 <b>The mention poll is FAILING</b>
          {poll.consecutiveErrors > 1 ? ` (${poll.consecutiveErrors} runs in a row)` : ""} — this is
          why tags get no response: <span className="text-red-300">{poll.lastError}</span>
          <span className="text-red-400"> · {poll.lastErrorAt ? timeAgo(poll.lastErrorAt) : ""}</span>
        </div>
      ) : (
        <p className="mb-4 text-xs text-neutral-500">
          ✅ Mention poll healthy — last checked {poll.lastOkAt ? timeAgo(poll.lastOkAt) : "just now"}
          , polls every 5 minutes{botUserId ? <> · watching account id <code>{botUserId}</code></> : null}.
          Flow: tag → &quot;🎬 On it&quot; ack (≤5 min) → clip reply (~5–15 min). Bare tags with no
          video link get an instructions reply.
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900 text-left text-neutral-400">
            <tr>
              <th className="p-2 font-medium">Requester</th>
              <th className="p-2 font-medium">Video</th>
              <th className="p-2 font-medium">Request</th>
              <th className="p-2 font-medium">Clip</th>
              <th className="p-2 font-medium">When</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="p-2">
                  <a href={`https://x.com/i/status/${r.tweetId}`} target="_blank" rel="noreferrer" className="hover:underline">
                    @{r.requester} ↗
                  </a>
                </td>
                <td className="max-w-md p-2">
                  {r.targetUrl ? (
                    <a href={r.targetUrl} target="_blank" rel="noreferrer" className="block truncate text-neutral-400 hover:underline" title={r.videoTitle ?? r.targetUrl}>
                      {r.videoTitle || r.targetUrl}
                    </a>
                  ) : (
                    <span className="text-neutral-600">— none in the tag or its parent</span>
                  )}
                </td>
                <td className="p-2">
                  <span title={STATUS_HINT[r.status] ?? ""} className={
                    r.status === "replied" ? "text-green-400"
                      : r.status === "clipped" || r.status === "received" ? "text-sky-300"
                      : r.status === "failed" ? "text-red-400"
                      : "text-neutral-400"
                  }>
                    {r.status}
                  </span>
                  <span className="ml-1 text-xs text-neutral-600">{STATUS_HINT[r.status] ? `· ${STATUS_HINT[r.status]}` : ""}</span>
                </td>
                <td className="p-2">
                  {r.clipStatus ? (
                    r.clipXPostId ? (
                      <a href={`https://x.com/i/status/${r.clipXPostId}`} target="_blank" rel="noreferrer" className="text-green-400 hover:underline">
                        posted ↗
                      </a>
                    ) : (
                      <span className="text-neutral-400">{r.clipStatus}</span>
                    )
                  ) : (
                    <span className="text-neutral-600">—</span>
                  )}
                </td>
                <td className="p-2 text-neutral-500">{r.createdAt ? timeAgo(r.createdAt) : ""}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="p-3 text-neutral-500">
                  No mentions seen yet. Every tag of the bot lands here within 5 minutes of being
                  posted — including bad ones (no video / too short / rejected). If you tagged it
                  longer ago than that and this is still empty, the poll banner above says why.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

async function load() {
  const database = db();
  const rows = await database
    .select().from(summonRequests)
    .orderBy(desc(summonRequests.createdAt)).limit(100);

  // Join in the candidate (video title once known) + clip (pipeline state, posted reply link).
  const candidateIds = rows.map((r) => r.candidateId).filter((id): id is number => id != null);
  const candMap = new Map<number, { title: string }>();
  const clipMap = new Map<number, { status: string; xPostId: string | null }>();
  if (candidateIds.length) {
    for (const c of await database
      .select({ id: candidates.id, title: candidates.title })
      .from(candidates).where(inArray(candidates.id, candidateIds))) {
      candMap.set(c.id, { title: c.title });
    }
    for (const c of await database
      .select({ candidateId: clips.candidateId, status: clips.status, xPostId: clips.xPostId })
      .from(clips).where(inArray(clips.candidateId, candidateIds))) {
      if (c.candidateId != null) clipMap.set(c.candidateId, { status: c.status, xPostId: c.xPostId });
    }
  }

  const health = await getXbotHealth();
  const poll = health.find((h) => h.component === "summon") ?? null;
  const settings = await getSettings().catch(() => null);

  return {
    poll,
    botUserId: settings?.xBotUserId ?? null,
    rows: rows.map((r) => ({
      ...r,
      videoTitle: r.candidateId != null ? candMap.get(r.candidateId)?.title ?? null : null,
      clipStatus: r.candidateId != null ? clipMap.get(r.candidateId)?.status ?? null : null,
      clipXPostId: r.candidateId != null ? clipMap.get(r.candidateId)?.xPostId ?? null : null,
    })),
  };
}
