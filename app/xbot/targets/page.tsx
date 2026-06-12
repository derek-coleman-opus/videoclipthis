import { desc } from "drizzle-orm";
import { db, xbotSeeds, xbotTargets } from "@/lib/db";
import XbotTargetsManager from "@/components/XbotTargetsManager";

export const dynamic = "force-dynamic";

export default async function XbotTargetsPage() {
  let data: Awaited<ReturnType<typeof load>>;
  try {
    data = await load();
  } catch (e) {
    return <div className="text-sm text-amber-300">Database not ready: {(e as Error).message}</div>;
  }

  return (
    <XbotTargetsManager
      targets={data.targets.map((t) => ({
        id: t.id,
        handle: t.handle,
        displayName: t.displayName ?? "",
        bio: t.bio ?? "",
        followers: t.followers ?? 0,
        score: t.score,
        source: t.source,
        status: t.status,
        repliesSent: t.repliesSent ?? 0,
        engagedBack: t.engagedBack ?? false,
      }))}
      seeds={data.seeds.map((s) => ({ id: s.id, handle: s.handle, active: s.active }))}
    />
  );
}

async function load() {
  const database = db();
  const targets = await database.select().from(xbotTargets).orderBy(desc(xbotTargets.createdAt)).limit(200);
  const seeds = await database.select().from(xbotSeeds).orderBy(desc(xbotSeeds.createdAt)).limit(50);
  return { targets, seeds };
}
