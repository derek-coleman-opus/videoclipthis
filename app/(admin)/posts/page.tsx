import { desc } from "drizzle-orm";
import { db, clips } from "@/lib/db";
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
            <p className="whitespace-pre-wrap text-sm text-neutral-200">{c.postText}</p>
            {c.status === "pending_review" && (
              <div className="mt-2">
                <ClipActions id={c.id} />
              </div>
            )}
          </li>
        ))}
        {rows.length === 0 && <li className="text-sm text-neutral-500">No clips yet.</li>}
      </ul>
    </div>
  );
}

async function load() {
  return db().select().from(clips).orderBy(desc(clips.createdAt)).limit(100);
}
