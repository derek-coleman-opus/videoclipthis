import DbError from "@/components/DbError";
import { sql } from "drizzle-orm";
import { db, candidates } from "@/lib/db";
import { getFigureRows } from "@/lib/figures-store";
import FiguresManager from "@/components/FiguresManager";
import { withSchemaHeal } from "@/lib/db/ensureSchema";

export const dynamic = "force-dynamic";

export default async function FiguresPage() {
  let figures: { id: number; name: string; xHandle: string; org: string; priority: number; clipped: number }[];
  try {
    const rows = await getFigureRows();
    const counts: Record<string, number> = {};
    // withSchemaHeal: this reads `candidates`, so a newly added column would 500 the page until
    // the migration was applied by hand.
    const c = await withSchemaHeal(() => db()
      .select({ name: candidates.figureName, n: sql<number>`count(*)::int` })
      .from(candidates)
      .groupBy(candidates.figureName));
    for (const r of c) if (r.name) counts[r.name] = Number(r.n);
    figures = rows.map((r) => ({
      id: r.id,
      name: r.name,
      xHandle: r.xHandle,
      org: r.org ?? "",
      priority: r.priority ?? 2,
      clipped: counts[r.name] ?? 0,
    }));
  } catch (e) {
    return <DbError error={e} />;
  }

  return (
    <div>
      <h2 className="mb-3 text-sm font-medium text-neutral-400">Tracked AI figures ({figures.length})</h2>
      <p className="mb-4 max-w-2xl text-xs text-neutral-500">
        They share talks &amp; videos worth clipping. Tracking them means we always know their @ to
        credit + tag, and their content auto-ranks higher. Add or remove people below — changes take
        effect on the next Scout run.
      </p>
      <FiguresManager figures={figures} />
    </div>
  );
}
