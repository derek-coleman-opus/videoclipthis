import { desc } from "drizzle-orm";
import { db, candidates } from "@/lib/db";

export const dynamic = "force-dynamic";

const STATUS_COLOR: Record<string, string> = {
  posted: "text-green-400",
  selected: "text-blue-400",
  scored: "text-neutral-300",
  found: "text-neutral-300",
  skipped: "text-neutral-500",
  held: "text-amber-400",
};

export default async function FoundPage() {
  let rows: Awaited<ReturnType<typeof load>>;
  try {
    rows = await load();
  } catch (e) {
    return <div className="text-sm text-amber-300">Database not ready: {(e as Error).message}</div>;
  }

  return (
    <div>
      <h2 className="mb-3 text-sm font-medium text-neutral-400">Candidates found ({rows.length})</h2>
      <div className="overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900 text-left text-neutral-400">
            <tr>
              <th className="p-2 font-medium">Title</th>
              <th className="p-2 font-medium">Source</th>
              <th className="p-2 font-medium">Channel</th>
              <th className="p-2 font-medium">Score</th>
              <th className="p-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {rows.map((c) => (
              <tr key={c.id}>
                <td className="p-2">
                  <a href={c.url} target="_blank" rel="noreferrer" className="hover:underline">{c.title}</a>
                </td>
                <td className="p-2 text-neutral-400">{c.source}</td>
                <td className="p-2 text-neutral-400">{c.channel}</td>
                <td className="p-2">{c.score ?? "—"}</td>
                <td className={`p-2 ${STATUS_COLOR[c.status] ?? "text-neutral-300"}`}>{c.status}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={5} className="p-3 text-neutral-500">Nothing found yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

async function load() {
  return db().select().from(candidates).orderBy(desc(candidates.createdAt)).limit(100);
}
