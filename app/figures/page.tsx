import { sql } from "drizzle-orm";
import { db, candidates } from "@/lib/db";
import { FIGURES } from "@/lib/pipeline/figures";

export const dynamic = "force-dynamic";

export default async function FiguresPage() {
  const counts: Record<string, number> = {};
  try {
    const rows = await db()
      .select({ name: candidates.figureName, n: sql<number>`count(*)::int` })
      .from(candidates)
      .groupBy(candidates.figureName);
    for (const r of rows) if (r.name) counts[r.name] = Number(r.n);
  } catch (e) {
    return <div className="text-sm text-amber-300">Database not ready: {(e as Error).message}</div>;
  }

  return (
    <div>
      <h2 className="mb-3 text-sm font-medium text-neutral-400">Tracked AI figures ({FIGURES.length})</h2>
      <p className="mb-4 max-w-2xl text-xs text-neutral-500">
        They share talks &amp; videos worth clipping. Tracking them means we always know their @ to
        credit + tag (the credit-first loop), and their content auto-ranks higher. Edit the list in{" "}
        <code>lib/pipeline/figures.ts</code>.
      </p>
      <div className="overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900 text-left text-neutral-400">
            <tr>
              <th className="p-2 font-medium">Figure</th>
              <th className="p-2 font-medium">@</th>
              <th className="p-2 font-medium">Org</th>
              <th className="p-2 font-medium">Priority</th>
              <th className="p-2 font-medium">Clipped</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {FIGURES.map((f) => (
              <tr key={f.xHandle}>
                <td className="p-2">{f.name}</td>
                <td className="p-2 text-neutral-400">@{f.xHandle}</td>
                <td className="p-2 text-neutral-400">{f.org ?? "—"}</td>
                <td className="p-2">{f.priority ?? "—"}</td>
                <td className="p-2">{counts[f.name] ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
