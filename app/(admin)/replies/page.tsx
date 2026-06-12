import { desc } from "drizzle-orm";
import { db, summonRequests } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function RepliesPage() {
  let rows: Awaited<ReturnType<typeof load>>;
  try {
    rows = await load();
  } catch (e) {
    return <div className="text-sm text-amber-300">Database not ready: {(e as Error).message}</div>;
  }

  return (
    <div>
      <h2 className="mb-3 text-sm font-medium text-neutral-400">Summon requests ({rows.length})</h2>
      <p className="mb-4 text-xs text-neutral-500">People who tagged @videoclipthis asking it to clip something.</p>
      <div className="overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900 text-left text-neutral-400">
            <tr>
              <th className="p-2 font-medium">Requester</th>
              <th className="p-2 font-medium">Target</th>
              <th className="p-2 font-medium">Status</th>
              <th className="p-2 font-medium">When</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="p-2">@{r.requester}</td>
                <td className="p-2">
                  <a href={r.targetUrl ?? "#"} target="_blank" rel="noreferrer" className="text-neutral-400 hover:underline">
                    {r.targetUrl}
                  </a>
                </td>
                <td className="p-2">{r.status}</td>
                <td className="p-2 text-neutral-500">{r.createdAt ? new Date(r.createdAt).toLocaleString() : ""}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={4} className="p-3 text-neutral-500">No summons yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

async function load() {
  return db().select().from(summonRequests).orderBy(desc(summonRequests.createdAt)).limit(100);
}
