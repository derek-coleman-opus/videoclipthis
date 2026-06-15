import { desc, eq } from "drizzle-orm";
import { db, clips, candidates } from "@/lib/db";
import ClipActions from "@/components/ClipActions";

export const dynamic = "force-dynamic";

export default async function PostsPage() {
  let rows: Awaited<ReturnType<typeof load>>;
  try {
    rows = await load();
  } catch (e) {
    return <div className="text-sm text-amber-300">Database not ready: {(e as Error).message}</div>;
  }

  return (
    <div>
      <h2 className="mb-3 text-sm font-medium text-neutral-400">Clips ({rows.length})</h2>
      <ul className="space-y-3">
        {rows.map((c) => (
          <li key={c.id} className="rounded-lg border border-neutral-800 bg-neutral-900 p-3">
            <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
              <span
                className={`rounded px-2 py-0.5 ${
                  c.status === "posted"
                    ? "bg-green-900/60 text-green-300"
                    : c.status === "pending_review"
                      ? "bg-amber-900/60 text-amber-300"
                      : "bg-neutral-800 text-neutral-400"
                }`}
              >
                {c.status}
              </span>
              <span className="text-neutral-500">{c.kind}</span>
              {c.resharedBySpeaker && <span className="text-green-400">↻ reshared by speaker</span>}
              {typeof c.views === "number" && c.views > 0 && (
                <span className="text-neutral-400">{c.views.toLocaleString()} views</span>
              )}
              <span className="ml-auto text-neutral-600">${(c.costUsd ?? 0).toFixed(2)}</span>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row">
              {/* The rendered clip — watch it to verify the moment + who's on screen. */}
              {c.clipUrl ? (
                <video
                  src={c.clipUrl}
                  controls
                  preload="metadata"
                  className="w-full rounded-md border border-neutral-800 bg-black sm:w-64"
                />
              ) : (
                <div className="flex w-full items-center justify-center rounded-md border border-dashed border-neutral-800 bg-black/40 p-6 text-xs text-neutral-600 sm:w-64">
                  no clip URL
                </div>
              )}

              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap text-sm text-neutral-200">{c.postText}</p>

                {/* Credit check: exactly who this post tags, vs the source to verify against. */}
                <div className="mt-2 text-xs text-neutral-500">
                  Crediting:{" "}
                  <span className="text-neutral-300">
                    {c.speakerHandle ? `@${c.speakerHandle}` : c.speaker || "— (no speaker resolved)"}
                  </span>
                  {c.figureName && <span> · 🎯 {c.figureName}</span>}
                  {c.title && <span className="text-neutral-600"> · {c.title}</span>}
                </div>
                <div className="mt-1 flex gap-3 text-xs">
                  {c.clipUrl && (
                    <a href={c.clipUrl} target="_blank" rel="noreferrer" className="text-neutral-400 underline hover:text-neutral-200">
                      open clip ↗
                    </a>
                  )}
                  {c.sourceUrl && (
                    <a href={c.sourceUrl} target="_blank" rel="noreferrer" className="text-neutral-400 underline hover:text-neutral-200">
                      source video ↗
                    </a>
                  )}
                </div>

                {c.status === "pending_review" && (
                  <div className="mt-2">
                    <ClipActions id={c.id} />
                  </div>
                )}
              </div>
            </div>
          </li>
        ))}
        {rows.length === 0 && <li className="text-sm text-neutral-500">No clips yet.</li>}
      </ul>
    </div>
  );
}

async function load() {
  return db()
    .select({
      id: clips.id,
      status: clips.status,
      kind: clips.kind,
      postText: clips.postText,
      clipUrl: clips.clipUrl,
      resharedBySpeaker: clips.resharedBySpeaker,
      views: clips.views,
      costUsd: clips.costUsd,
      createdAt: clips.createdAt,
      speaker: candidates.speaker,
      speakerHandle: candidates.speakerHandle,
      figureName: candidates.figureName,
      title: candidates.title,
      sourceUrl: candidates.url,
    })
    .from(clips)
    .leftJoin(candidates, eq(clips.candidateId, candidates.id))
    .orderBy(desc(clips.createdAt))
    .limit(100);
}
